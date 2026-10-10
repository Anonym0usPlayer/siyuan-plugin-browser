/**
 * 内容脚本 chrome.* API 真实绑定（webContents.debugger 版）。
 *
 * 根因（2026-10-10 实测定案）：Electron 对 content script 的扩展 API 注入只做了
 * 命名空间占位 —— isolated world 的 chrome 对象 {dom,i18n,runtime,storage} 键存在、
 * 值全是 undefined，content script 顶层一碰 chrome.storage 就抛 TypeError。
 * 页面内垫片补不了：CS 在我们注入前就死了，且 isolated world 由 Chromium C++ 创建。
 *
 * 方案：不修 Electron 的世界，自建世界。
 * 1. 传输层用 webContents.debugger（@electron/remote 拿到 webview 的 webContents）：
 *    进程内 CDP，不依赖 --remote-debugging-port；渲染进程的浏览器 WebSocket 连
 *    ws://127.0.0.1 会被 https 页面混合内容策略拦截（实测），debugger API 无此问题。
 * 2. dom-ready 时对每个原生加载、且内容脚本引用 chrome.* 的扩展：
 *    Page.createIsolatedWorld（grantUniversalAccess）→ 专属世界（命名
 *    __syCsRt_<electronId>，evalInExtensionWorld 按 name 优先匹配）；
 * 3. Runtime.addBinding 注入 __syExtHost 桥（CS→宿主方向）+ Runtime.evaluate
 *    注入完整 chrome.runtime / chrome.storage / chrome.i18n 实现 ——
 *    异步操作经桥到宿主，宿主经扩展 SW 的真实 chrome.storage 代答
 *    （SW 通道走 sw-bridge 的 Node WebSocket，sync/session 代理到 local）；
 * 4. chrome.runtime.sendMessage 经 SW 垫片 v4 的 storage 路由（__syRouteIn /
 *    __syRouteResp_<id>）往返 —— 与 SW 侧收集的 onMessage handlers 配对；
 * 5. 内容脚本入口文件从磁盘读出后在该世界执行 —— chrome API 全程可用，
 *    顶层初始化不再抛错。Electron 原生世界照旧注入（空壳死代码，无碍）；
 *    纯 DOM 型扩展（源码不引用 chrome.*，如 Eruda）跳过自建世界，避免双重执行。
 *
 * 时序：世界由宿主创建、CS 由宿主执行 —— 没有竞速问题；同进程导航会话不断开
 * （frameNavigated 换 frameId 后重建世界），跨进程导航/页签销毁由 detach 事件
 * 与 disposeCsRuntime 清理。
 */
import type { IWebviewTag } from "../types";
import { CS_WORLD_PREFIX, cdpEvalOnce, cdpHttpLikelyDead, evalInSwFlat, findSwTarget, SW_FLAT_UNAVAILABLE } from "./sw-bridge";

const BRIDGE_NAME = "__syExtHost";
/** popup/options 页专属世界前缀（独立于 content 世界，避免顶层声明冲突） */
const POPUP_WORLD_PREFIX = "__syCsPop_";

export interface ICsExtInfo {
    electronId: string;
    path: string;
    name: string;
    version: string;
    defaultLocale: string;
    contentScripts: Array<{ matches: string[]; js: string[]; css: string[] }>;
}

/** 宿主能力提供者（extensionHost 实现），避免模块循环依赖 */
export interface ICsRuntimeHost {
    listNativeExts(): ICsExtInfo[];
    readFile(extPath: string, rel: string): string;
    messages(extPath: string, defaultLocale: string): Record<string, any>;
    /** 唤醒单个扩展 SW（removeExtension + loadExtension），返回回传的（可能更新过的）id */
    wakeOne(electronId: string): Promise<string | null>;
    /** 无副作用唤醒 SW（startWorkerForScope，不卸载扩展）——正在打开的扩展
     *  面板世界会随 removeExtension 被销毁（binding 失效 → hostCall 永挂），
     *  面板/存储路径的唤醒必须用这个 */
    wakeSw?(electronId: string): Promise<void>;
}

let manager: CsRuntimeManager | null = null;

export function initCsRuntime(host: ICsRuntimeHost): void {
    manager = new CsRuntimeManager(host);
}

export function ensureCsRuntime(webview: IWebviewTag): void {
    manager?.ensure(webview).catch((e) => {
        console.warn("[browser-plugin] cs-runtime ensure failed:", e);
    });
}

export function disposeCsRuntime(webview: IWebviewTag): void {
    manager?.disposeFor(webview);
}

/** popup eval 轨迹（主窗口可读；用于判断是否所有脚本落在同一个世界） */
function traceEval(entry: { ctxId: number; len: number; ok: boolean; err?: string }): void {
    try {
        const log = ((window as any).__syPopupLog = (window as any).__syPopupLog || []);
        log.push({ ts: Date.now(), ...entry });
        if (log.length > 40) log.splice(0, log.length - 40);
    } catch (e) {}
}

/** 开始一次 popup 会话：新建专属世界（同一次打开的后续 eval 共享该世界） */
export async function beginPopupWorld(webview: IWebviewTag, ext: ICsExtInfo): Promise<void> {
    if (!manager) return;
    await manager.beginPopup(webview, ext).catch((e) => {
        console.warn("[browser-plugin] beginPopupWorld failed:", e);
    });
}

/**
 * 在当前 popup 会话的世界里执行表达式（需先 beginPopupWorld）。
 * chrome.* 经桥真实可用；DOM 与页面共享。
 */
export async function evalPopupJs(webview: IWebviewTag, ext: ICsExtInfo, expr: string): Promise<{ ok: boolean; value?: any; error?: string }> {
    if (!manager) return { ok: false, error: "cs-runtime 未初始化" };
    return manager.evalPopupJs(webview, ext, expr);
}

// ===== Chrome match pattern（与 extensionHost 同款，独立副本避免模块循环） =====

function matchesUrlPattern(pattern: string, rawUrl: string): boolean {
    if (pattern === "<all_urls>") return /^https?:\/\//i.test(rawUrl);
    const m = pattern.match(/^(\*|https?|file|ftp|urn):\/\/(\*(?:\.[^/*]+)?|\*|[^/*]+)(\/.*)$/);
    if (!m) return false;
    const [, scheme, hostPat, pathPat] = m;
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return false;
    }
    const urlScheme = url.protocol.replace(":", "");
    if (scheme === "*") {
        if (urlScheme !== "http" && urlScheme !== "https") return false;
    } else if (scheme !== urlScheme) {
        return false;
    }
    const host = url.hostname;
    const hostWithPort = url.host;
    const hostMatches = (pat: string) => pat === host || pat === hostWithPort;
    if (hostPat === "*") {
        // 任意主机
    } else if (hostPat.startsWith("*.")) {
        const base = hostPat.slice(2);
        if (!hostMatches(base) && !host.endsWith("." + base) && !hostWithPort.endsWith("." + base)) return false;
    } else if (!hostMatches(hostPat)) {
        return false;
    }
    const path = url.pathname + url.search;
    const regex = new RegExp("^" + pathPat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return regex.test(path);
}

// ===== webview → webContents（@electron/remote） =====

function remoteWebContents(webview: IWebviewTag): any | null {
    try {
        const req = (window as any).require;
        const remote = req?.("@electron/remote");
        const wid = (webview as any).getWebContentsId?.();
        if (!remote?.webContents?.fromId || wid == null) return null;
        const wc = remote.webContents.fromId(wid);
        return wc && !wc.isDestroyed?.() ? wc : null;
    } catch {
        return null;
    }
}

// ===== 世界/会话管理 =====

class CsRuntimeManager {
    private host: ICsRuntimeHost;
    /** webContents.id → 会话 */
    private sessions = new Map<string, CsPageSession>();

    constructor(host: ICsRuntimeHost) {
        this.host = host;
    }

    async ensure(webview: IWebviewTag): Promise<void> {
        const pageUrl = safeUrl(webview);
        if (!/^https?:\/\//i.test(pageUrl)) return;
        const wc = remoteWebContents(webview);
        if (!wc) {
            console.warn("[browser-plugin] cs-runtime: webContents 不可用（@electron/remote/getWebContentsId 失败）");
            return;
        }
        const key = String(wc.id);
        const existing = this.sessions.get(key);
        if (existing && existing.alive) {
            existing.pageUrl = pageUrl;
            await existing.sync();
            return;
        }
        const s = new CsPageSession(wc, pageUrl, this.host, () => this.sessions.delete(key));
        this.sessions.set(key, s);
        await s.start();
        await s.sync();
    }

    disposeFor(webview: IWebviewTag): void {
        const wc = remoteWebContents(webview);
        if (!wc) return;
        const key = String(wc.id);
        const s = this.sessions.get(key);
        if (s) {
            s.close();
            this.sessions.delete(key);
        }
    }

    private async sessionFor(webview: IWebviewTag): Promise<CsPageSession> {
        const pageUrl = safeUrl(webview);
        const wc = remoteWebContents(webview);
        if (!wc) throw new Error("webContents 不可用");
        const key = String(wc.id);
        let s = this.sessions.get(key);
        if (!s || !s.alive) {
            s = new CsPageSession(wc, pageUrl, this.host, () => this.sessions.delete(key));
            this.sessions.set(key, s);
            await s.start();
        }
        s.pageUrl = pageUrl;
        return s;
    }

    /** 开始一次 popup 会话：为该扩展新建专属世界（每次调用都新建，防跨打开声明冲突） */
    async beginPopup(webview: IWebviewTag, ext: ICsExtInfo): Promise<void> {
        const dbg = (msg: any) => {
            try {
                (window as any).__syPopupDbg = { ts: Date.now(), ext: ext.name, ...(typeof msg === "object" ? msg : { msg }) };
            } catch (e) {}
        };
        const s = await this.sessionFor(webview);
        // frameId 可能在导航后变陈旧（世界会挂到失效 frame 上 → 后续 evaluate 无效果），
        // 建世界前重新取一次，并在建完后探测存活，失败则刷新重建一次
        await s.refreshFrameId().catch(() => {});
        let ctxId = await s.ensurePopupWorld(ext);
        const alive = await s.probeWorld(ctxId);
        if (!alive) {
            await s.refreshFrameId().catch(() => {});
            ctxId = await s.ensurePopupWorld(ext);
            const alive2 = await s.probeWorld(ctxId);
            dbg({ ok: true, begin: true, ctxId, retried: !alive2 ? "dead" : "ok" });
            return;
        }
        dbg({ ok: true, begin: true, ctxId });
    }

    async evalPopupJs(webview: IWebviewTag, ext: ICsExtInfo, expr: string): Promise<{ ok: boolean; value?: any; error?: string }> {
        // 页面任意 URL（含 about:blank / data: 查看源代码页）都可承载 popup ——
        // 传输走 webContents.debugger，与页面类型无关；仅 content script 注入限定 http(s)
        const dbg = (msg: any) => {
            try {
                (window as any).__syPopupDbg = { ts: Date.now(), ext: ext.name, ...(typeof msg === "object" ? msg : { msg }) };
            } catch (e) {}
        };
        try {
            const s = await this.sessionFor(webview);
            const ctxId = s.currentPopupCtx(ext.electronId);
            if (!ctxId) return { ok: false, error: "popup 世界未初始化（未 begin）" };
            const r = await s.evaluateInWorld(ctxId, expr);
            dbg({ ...r, ctxId });
            traceEval({ ctxId, len: expr.length, ok: r.ok, err: r.error });
            return r;
        } catch (e: any) {
            const err = String(e?.message || e);
            dbg({ ok: false, error: err });
            return { ok: false, error: err };
        }
    }

    /** manager 级 SW eval：任一存活会话（HTTP→flat 双通道）→ 主窗口兜底 */
    async evalInSwAny(electronId: string, expr: string): Promise<{ value?: any; err?: string }> {
        for (const s of this.sessions.values()) {
            if (!s.alive) continue;
            const r = await s.evalInSw({ electronId } as ICsExtInfo, expr);
            if (r.err !== SW_FLAT_UNAVAILABLE || r.value !== undefined) return r;
            // 该会话两条通道都不可用 → 换下一个
        }
        return await evalInSwViaMainWindow(electronId, expr);
    }

    /** manager 级 isolated world 直调：为该 webview 取会话走 flat 通道 */
    async evalExtensionWorldAny(webview: IWebviewTag, electronId: string, expr: string): Promise<{ ok: boolean; value?: any; error?: string; contextId?: number }> {
        const s = await this.sessionFor(webview);
        return await s.evalInExtensionWorldFlat(electronId, expr);
    }
}

class CsPageSession {
    private seq = 0;
    private frameId: string | null = null;
    /** electronId → content 世界 contextId（跑内容脚本） */
    private contentWorlds = new Map<string, number>();
    /** electronId → 当前 popup 世界 contextId（每次打开面板新建） */
    private popupWorldByExt = new Map<string, number>();
    /** popup 世界 contextId → electronId（桥调用反查） */
    private popupCtxs = new Map<number, string>();
    /** 当前文档已执行过 CS 入口的扩展（导航后清空） */
    private ran = new Set<string>();
    private attached = false;
    private ctxToExt = new Map<number, string>();

    constructor(
        private wc: any,
        public pageUrl: string,
        private host: ICsRuntimeHost,
        private onDead: () => void
    ) {}

    get alive(): boolean {
        return this.attached && !this.wc.isDestroyed?.();
    }

    close(): void {
        if (this.attached) {
            try {
                this.wc.debugger.detach();
            } catch {}
            this.attached = false;
        }
    }

    private send(method: string, params: any = {}, timeoutMs = 15000, sessionId?: string): Promise<any> {
        return Promise.race([
            this.wc.debugger.sendCommand(method, params, sessionId),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`CDP ${method} 超时`)), timeoutMs)),
        ]);
    }

    /** Node http(s) 代发内核请求（面板/内容世界的 mixed content 绕行）。
     *  用户配置的 ip scheme 可能与内核真实协议不符（如 http:// 配到 https 内核）——
     *  失败后自动交换协议重试一次。 */
    private async kernelFetchNode(
        url: string,
        method: string,
        headers: Record<string, string>,
        body?: string
    ): Promise<{ status: number; bodyText: string }> {
        let u: URL;
        try {
            u = new URL(url);
        } catch {
            return { status: 0, bodyText: "" };
        }
        const attempt = (scheme: string): Promise<{ status: number; bodyText: string }> =>
            new Promise((resolve) => {
                const req = (window as any).require;
                if (!req) { resolve({ status: 0, bodyText: "" }); return; }
                const lib = scheme === "https" ? req("https") : req("http");
                let settled = false;
                const done = (v: { status: number; bodyText: string }) => {
                    if (settled) return;
                    settled = true;
                    resolve(v);
                };
                try {
                    const rq = lib.request(
                        {
                            hostname: u.hostname,
                            port: u.port || (scheme === "https" ? 443 : 80),
                            path: u.pathname + u.search,
                            method,
                            headers,
                            // 思源内核是自签名证书 —— Node 默认拒绝，必须放宽
                            rejectUnauthorized: false,
                        },
                        (res: any) => {
                            let data = "";
                            res.on("data", (c: any) => { data += c; });
                            res.on("end", () => done({ status: res.statusCode || 0, bodyText: data }));
                            res.on("error", () => done({ status: 0, bodyText: "" }));
                        }
                    );
                    rq.setTimeout(30000, () => {
                        try { rq.destroy(); } catch (e) {}
                        done({ status: 0, bodyText: "" });
                    });
                    rq.on("error", () => done({ status: 0, bodyText: "" }));
                    if (body !== undefined) rq.write(body);
                    rq.end();
                } catch (e) {
                    done({ status: 0, bodyText: "" });
                }
            });
        const scheme0 = u.protocol.replace(":", "") || "http";
        const first = await attempt(scheme0);
        if (first.status === 0) {
            // 协议可能配反（http:// 配到 https 内核）→ 交换协议重试一次
            const alt = scheme0 === "http" ? "https" : "http";
            return await attempt(alt);
        }
        return first;
    }

    async start(): Promise<void> {
        try {
            this.wc.debugger.attach("1.3");
        } catch (e: any) {
            const msg = String(e?.message || e);
            if (!msg.includes("already attached")) throw new Error("debugger attach 失败: " + msg);
        }
        this.attached = true;
        this.wc.debugger.on("message", (_event: any, method: string, params: any) => {
            this.onCdpEvent(method, params);
        });
        this.wc.debugger.on("detach", () => {
            this.attached = false;
            this.onDead();
        });
        await this.send("Page.enable");
        await this.send("Runtime.enable");
        const tree: any = await this.send("Page.getFrameTree");
        // 注意返回结构是 {frameTree: {frame}}，不是 {frame}（取错层级 → frameId 恒 null → sync 静默跳过）
        this.frameId = tree?.frameTree?.frame?.id || tree?.frame?.id || null;
    }

    private onCdpEvent(method: string, params: any): void {
        if (method === "Page.frameNavigated" && params?.frame && !params.frame.parentId) {
            // 主框架导航：世界与执行标记全部作废，sync 时按新文档重建
            this.frameId = String(params.frame.id || this.frameId);
            this.contentWorlds.clear();
            this.popupWorldByExt.clear();
            this.popupCtxs.clear();
            this.ran.clear();
            this.ctxToExt.clear();
            return;
        }
        if (method === "Runtime.executionContextCreated") {
            // Electron 原生注入的扩展 CS 世界（空壳 chrome 死代码）静默化：
            // 其周期性 chrome.runtime.sendMessage 调用会持续刷
            // "Unchecked runtime.lastError: Could not establish connection"（用户可见噪音）
            const c = params?.context || {};
            const isIsolated = c.type === "isolated" || (c.auxData && c.auxData.type === "isolated");
            const cname = String(c.name || "");
            if (isIsolated
                && String(c.origin || "").indexOf("chrome-extension://") === 0
                && cname.indexOf(CS_WORLD_PREFIX) !== 0
                && cname.indexOf(POPUP_WORLD_PREFIX) !== 0) {
                void this.silenceNativeWorld(Number(c.id));
            }
            return;
        }
        if (method === "Runtime.bindingCalled" && params?.name === BRIDGE_NAME) {
            void this.onBridgeCall(Number(params.executionContextId), String(params.payload || "{}"));
        }
    }

    private silencedCtxs = new Set<number>();

    /** 原生世界静默桩：chrome.runtime.sendMessage/tabs.sendMessage 变 no-op，
     *  消除死代码副本的 lastError 刷屏。功能由自建世界（__syCsRt_）承担。 */
    private async silenceNativeWorld(ctxId: number): Promise<void> {
        if (this.silencedCtxs.has(ctxId) || this.silencedCtxs.size > 200) return;
        this.silencedCtxs.add(ctxId);
        try {
            await this.send(
                "Runtime.evaluate",
                {
                    expression: `(function () {
                        try {
                            if (window.__sySilenced) return;
                            window.__sySilenced = true;
                            if (typeof chrome === "undefined" || !chrome.runtime) return;
                            var eventHub = function () {
                                return { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } };
                            };
                            var noSend = function () { return Promise.resolve(undefined); };
                            try { Object.defineProperty(chrome.runtime, "sendMessage", { configurable: true, get: function () { return noSend; } }); } catch (e) {}
                            try { if (chrome.tabs) { Object.defineProperty(chrome.tabs, "sendMessage", { configurable: true, get: function () { return noSend; } }); } } catch (e) {}
                            try { chrome.runtime.onMessage = eventHub(); } catch (e) {}
                        } catch (e) {}
                    })()`,
                    contextId: ctxId,
                    returnByValue: false,
                },
                5000
            );
        } catch {}
    }

    /** 确保当前文档里所有适用扩展都有可用世界并已执行 CS */
    async sync(): Promise<void> {
        if (!this.alive || !this.frameId) return;
        const exts = this.host.listNativeExts();
        for (const ext of exts) {
            try {
                await this.installExt(ext);
            } catch (e) {
                console.warn(`[browser-plugin] cs-runtime: "${ext.name}" 世界安装失败:`, e);
            }
        }
    }

    private async installExt(ext: ICsExtInfo): Promise<void> {
        if (this.contentWorlds.has(ext.electronId) && this.ran.has(ext.electronId)) return;
        // 只把「源码引用 chrome.*」的内容脚本搬进自建世界：纯 DOM 型扩展
        // （Eruda 等）在原生世界本来就正常，重复执行会出双份 UI
        const groups = (ext.contentScripts || []).filter((cs) =>
            (cs.matches || []).some((p) => matchesUrlPattern(p, this.pageUrl))
        );
        if (groups.length === 0) return;
        const needsCsRt = groups.some((cs) =>
            (cs.js || []).some((f) => {
                try {
                    return /chrome\s*\.\s*(runtime|storage|tabs|i18n|contextMenus)/.test(this.host.readFile(ext.path, f));
                } catch {
                    return false;
                }
            })
        );
        if (!needsCsRt) return;

        let ctxId = this.contentWorlds.get(ext.electronId);
        if (!ctxId) {
            const r: any = await this.send("Page.createIsolatedWorld", {
                frameId: this.frameId,
                worldName: CS_WORLD_PREFIX + ext.electronId,
                grantUniversalAccess: true,
                allowCommandLineAPI: false,
            });
            ctxId = r?.executionContextId;
            if (!ctxId) throw new Error("createIsolatedWorld 未返回 contextId");
            this.contentWorlds.set(ext.electronId, ctxId);
            await this.send("Runtime.addBinding", { name: BRIDGE_NAME, executionContextId: ctxId });
            const shim = buildShim(ext, this.host.messages(ext.path, ext.defaultLocale));
            const sr: any = await this.send("Runtime.evaluate", {
                expression: shim,
                contextId: ctxId,
                returnByValue: false,
            });
            if (sr?.exceptionDetails) {
                throw new Error(
                    "垫片执行异常: " + String(sr.exceptionDetails?.exception?.description || sr.exceptionDetails?.text).slice(0, 200)
                );
            }
        }
        if (this.ran.has(ext.electronId)) return;
        // 执行内容脚本入口（源码来自磁盘；世界是我们建的，不存在重声明冲突）
        const errors: string[] = [];
        for (const cs of groups) {
            for (const f of cs.js || []) {
                try {
                    const src = this.host.readFile(ext.path, f);
                    const r: any = await this.send("Runtime.evaluate", {
                        expression: src,
                        contextId: ctxId,
                        returnByValue: false,
                    });
                    if (r?.exceptionDetails) {
                        errors.push(
                            `${f}: ` +
                                String(r.exceptionDetails?.exception?.description || r.exceptionDetails?.text || "unknown")
                                    .split("\n")[0]
                                    .slice(0, 160)
                        );
                    }
                } catch (e: any) {
                    errors.push(`${f}: ${String(e?.message || e).slice(0, 160)}`);
                }
            }
        }
        this.ran.add(ext.electronId);
        if (errors.length) {
            console.warn(`[browser-plugin] cs-runtime: "${ext.name}" 内容脚本执行异常: ${JSON.stringify(errors)}`);
        } else {
            console.log(`[browser-plugin] cs-runtime: "${ext.name}" 内容脚本已在自建世界运行 (${ext.electronId})`);
        }
    }

    // ===== CS → 宿主 桥请求 =====

    private async onBridgeCall(ctxId: number, payload: string): Promise<void> {
        let req: any;
        try {
            req = JSON.parse(payload);
        } catch {
            return;
        }
        let electronId = this.ctxToExt.get(ctxId);
        if (!electronId) {
            electronId = this.popupCtxs.get(ctxId) || null;
            if (!electronId) {
                for (const [eid, cid] of this.contentWorlds) {
                    if (cid === ctxId) {
                        electronId = eid;
                        break;
                    }
                }
            }
            if (electronId) this.ctxToExt.set(ctxId, electronId);
        }
        const ext = this.host.listNativeExts().find((e) => e.electronId === electronId);
        const result = ext
            ? await this.route(ext, req).catch((e) => ({ err: String(e?.message || e) }))
            : { err: "unknown context" };
        try {
            await this.send(
                "Runtime.evaluate",
                {
                    expression: `window.__syExtHostResolve && window.__syExtHostResolve(${JSON.stringify(
                        JSON.stringify({ reqId: req.reqId, ...result })
                    )})`,
                    contextId: ctxId,
                    returnByValue: false,
                },
                10000
            );
        } catch {}
    }

    private async route(ext: ICsExtInfo, req: any): Promise<{ data?: any; err?: string }> {
        const args = req.args || {};
        if (req.type === "storage") {
            const op = String(args.op || "get");
            // sync/session 代理到 local（与扩展页垫片 83a6d9b 同策略）
            const payloadJson = JSON.stringify(args.payload === undefined ? null : args.payload);
            const exprs: Record<string, string> = {
                get: `(async () => JSON.stringify(await chrome.storage.local.get(${payloadJson})))()`,
                set: `(async () => { await chrome.storage.local.set(${payloadJson}); return "ok"; })()`,
                remove: `(async () => { await chrome.storage.local.remove(${payloadJson}); return "ok"; })()`,
                clear: `(async () => { await chrome.storage.local.clear(); return "ok"; })()`,
            };
            const expr = exprs[op];
            if (!expr) return { err: "unknown storage op: " + op };
            const r = await this.evalInSw(ext, expr);
            if (r.err) return { err: r.err };
            if (op === "get") {
                try {
                    return { data: JSON.parse(String(r.value)) };
                } catch {
                    return { data: {} };
                }
            }
            return { data: undefined };
        }
        if (req.type === "kernelfetch") {
            // 面板/内容世界的内核请求代理（mixed content 绕行）：Node http 代发
            const url = String(args.url || "");
            const method = String(args.method || "GET").toUpperCase();
            const headers = (args.headers && typeof args.headers === "object") ? args.headers : {};
            const body = args.body === undefined || args.body === null ? undefined : String(args.body);
            const r = await this.kernelFetchNode(url, method, headers, body);
            return { data: r };
        }
        if (req.type === "sendmessage") {
            return await this.routeSendMessage(ext, args);
        }
        if (req.type === "portmessage") {
            // portmessage：扩展用长连接端口取状态（AdGuard Messenger 等），
            // 走 SW 垫片 v5 的 onConnect 端口语义（建连/复用 + outbox 回包）
            return await this.routePortMessage(ext, args);
        }
        if (req.type === "tabevent") {
            // popup 世界 tabs.query 时同步喂 SW 的 tab 注册表
            // （AdGuard 的 tabsApi 靠 tabs 事件建 tabContext，Electron 下事件缺失）
            return await this.feedTabEventToSw(ext, args);
        }
        if (req.type === "tabs-sendmessage") {
            // popup 世界 → content 世界的 onMessage 监听器（SW↔CS 路由缺失的替代）
            return await this.dispatchToContentWorld(ext, args);
        }
        return { err: "unknown bridge type: " + req.type };
    }

    /**
     * CS→SW 消息：宿主经 CDP 直调 SW 垫片 v4 收集的 onMessage handlers。
     * 不走 storage.onChanged 中转 —— 实测 Electron SW 里该事件不可靠（自写不触发）。
     * 语义对齐 Chrome：handler 返回 true = 异步 sendResponse；否则首个非 undefined
     * 同步返回值即响应；无处理器/超时按 undefined 回调。
     */
    private async routeSendMessage(ext: ICsExtInfo, args: any): Promise<{ data?: any; err?: string }> {
        const msgJson = JSON.stringify(args.msg === undefined ? null : args.msg);
        const senderJson = JSON.stringify({ id: ext.electronId, url: String(args.senderUrl || "").slice(0, 300) });
        const expr = `(async () => {
            const fns = self.__syOnMessageHandlers || [];
            if (!fns.length) return JSON.stringify({ __noHandlers: true });
            return await new Promise((resolve) => {
                let done = false;
                const finish = (v) => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    resolve(JSON.stringify(v === undefined ? null : v));
                };
                const timer = setTimeout(() => finish(null), 25000);
                let asyncWait = false;
                const sendResponse = (resp) => finish(resp);
                // handler 返回 Promise（async 函数）→ 等其 resolve 作为响应（此前直接丢弃 → 应用收到 undefined 而崩）
                const useValue = (v) => { if (v !== undefined) finish(v); };
                for (const fn of fns) {
                    try {
                        const r = fn(${msgJson}, ${senderJson}, sendResponse);
                        if (r === true) {
                            asyncWait = true;
                        } else if (r !== undefined) {
                            if (typeof r.then === "function") {
                                asyncWait = true;
                                r.then(useValue, () => finish(undefined));
                            } else {
                                finish(r);
                                break;
                            }
                        }
                    } catch (e) {}
                }
                if (!asyncWait && !done) finish(undefined);
            });
        })()`;
        const r = await this.evalInSw(ext, expr);
        if (r.err) return { err: r.err };
        try {
            let parsed = JSON.parse(String(r.value));
            // SW 刚被 loadExtension 唤醒时 app 尚在初始化（AdGuard 过滤器加载 5-10s），
            // handler 注册滞后 → __noHandlers 重试几轮，覆盖首开窗口期
            let tries = 0;
            while (parsed && parsed.__noHandlers && tries < 3) {
                tries++;
                await new Promise((res) => setTimeout(res, 1500));
                const r2 = await this.evalInSw(ext, expr);
                if (r2.err) return { err: r2.err };
                parsed = JSON.parse(String(r2.value));
            }
            if (parsed && parsed.__noHandlers) return { err: "扩展 SW 无 onMessage 处理器（垫片未运行？）" };
            return { data: parsed === null ? undefined : parsed };
        } catch {
            return { data: undefined };
        }
    }

    /**
     * popup 世界 port 消息 → SW onConnect 端口语义（SW 垫片 v5）。
     * 首条消息建连：构造 port 对象派发给 __syOnConnectFns（扩展 handler 同步
     * 注册 port.onMessage listeners）；随后 dispatch 消息并等待 outbox
     * （handler 异步 port.postMessage 回包）带回响应。同一 portId 复用端口，
     * 与真 Chrome 的 connect → postMessage 往返语义对齐。
     */
    private async routePortMessage(ext: ICsExtInfo, args: any): Promise<{ data?: any; err?: string }> {
        const portId = String(args.portId || "p" + Date.now().toString(36));
        const portName = String(args.portName || "");
        const msgJson = JSON.stringify(args.msg === undefined ? null : args.msg);
        const senderJson = JSON.stringify({ id: ext.electronId, url: String(args.senderUrl || "").slice(0, 300) });
        const pidJson = JSON.stringify(portId);
        const expr = `(async () => {
            try {
                self.__syPorts = self.__syPorts || {};
                self.__syPortOutbox = self.__syPortOutbox || {};
                var outbox = self.__syPortOutbox[${pidJson}];
                var listeners = null;
                var port = self.__syPorts[${pidJson}];
                if (!port) {
                    var fns = self.__syOnConnectFns || [];
                    if (!fns.length) return JSON.stringify({ __noConnectHandlers: true });
                    listeners = [];
                    outbox = [];
                    self.__syPortOutbox[${pidJson}] = outbox;
                    port = {
                        name: ${JSON.stringify(portName)},
                        sender: ${senderJson},
                        error: null,
                        onMessage: {
                            addListener: function (fn) { if (typeof fn === "function") listeners.push(fn); },
                            removeListener: function (fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
                            hasListener: function (fn) { return listeners.indexOf(fn) >= 0; },
                        },
                        onDisconnect: { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } },
                        postMessage: function (msg) { outbox.push(msg === undefined ? null : msg); },
                        disconnect: function () { delete self.__syPorts[${pidJson}]; },
                    };
                    self.__syPorts[${pidJson}] = port;
                    for (var i = 0; i < fns.length; i++) { try { fns[i](port); } catch (e) {} }
                    if (!listeners.length) return JSON.stringify({ __noPortListeners: true });
                } else {
                    // 复用端口：从 port 对象恢复 listeners（垫片闭包不可达，存 port 上）
                    listeners = port.__syListeners || [];
                }
                if (!port.__syListeners) port.__syListeners = listeners;
                var m = ${msgJson};
                var ls = listeners.slice();
                for (var j = 0; j < ls.length; j++) { try { ls[j](m, port); } catch (e) {} }
                // 等 handler 异步 postMessage 回包（同步回包在 dispatch 后立即就在 outbox）
                var resp = await new Promise(function (resolve) {
                    var n = 0;
                    var t = setInterval(function () {
                        if (outbox.length) {
                            clearInterval(t);
                            var arr = outbox.slice();
                            outbox.length = 0;
                            resolve(arr);
                        } else if (++n > 200) {
                            clearInterval(t);
                            resolve([]);
                        }
                    }, 50);
                });
                return JSON.stringify(resp);
            } catch (e) {
                return JSON.stringify({ __portErr: String(e && e.message || e).slice(0, 200) });
            }
        })()`;
        const r = await this.evalInSw(ext, expr);
        if (r.err) return { err: r.err };
        try {
            let parsed = JSON.parse(String(r.value));
            // SW 唤醒后 app 初始化窗口期：onConnect handler 可能尚未注册 → 重试几轮
            let tries = 0;
            while (parsed && (parsed.__noConnectHandlers || parsed.__noPortListeners) && tries < 4) {
                tries++;
                await new Promise((res) => setTimeout(res, 1500));
                const r2 = await this.evalInSw(ext, expr);
                if (r2.err) return { err: r2.err };
                parsed = JSON.parse(String(r2.value));
            }
            if (parsed && parsed.__noConnectHandlers) return { err: "扩展 SW 无 onConnect 处理器（垫片 v5 未生效？）" };
            if (parsed && parsed.__noPortListeners) return { err: "扩展 SW onConnect 处理器未注册 port.onMessage 监听" };
            if (parsed && parsed.__portErr) return { err: "port 路由异常: " + parsed.__portErr };
            // parsed = 响应数组（可能多条）；空数组按无响应处理
            if (Array.isArray(parsed)) {
                return { data: parsed.length ? parsed : undefined };
            }
            return { data: parsed === null ? undefined : parsed };
        } catch {
            return { data: undefined };
        }
    }

    /**
     * 把"当前标签"喂进 SW 的 tab 注册表（垫片 v5 收集的 tabs 事件 listeners）。
     * AdGuard 的 tabsApi 纯靠 tabs.onCreated/onUpdated 维护 tabContext Map，
     * Electron 下事件缺失 → getTabContext 恒 undefined → popup 取状态静默失败。
     * tabId 与垫片 tabs.query 返回的固定 id=1 对齐。
     */
    private async feedTabEventToSw(ext: ICsExtInfo, args: any): Promise<{ data?: any; err?: string }> {
        const tabJson = JSON.stringify({
            id: 1, index: 0, windowId: 1, active: true, highlighted: true, pinned: false,
            incognito: false, url: String(args?.url || ""), title: String(args?.title || ""),
        });
        const expr = `(function () {
            try {
                var tab = ${tabJson};
                var cfns = self.__syTabCreatedFns || [];
                for (var i = 0; i < cfns.length; i++) { try { cfns[i](tab); } catch (e) {} }
                var afns = self.__syTabActivatedFns || [];
                for (var a = 0; a < afns.length; a++) { try { afns[a]({ tabId: tab.id, windowId: tab.windowId }); } catch (e) {} }
                var ufns = self.__syTabUpdatedFns || [];
                for (var j = 0; j < ufns.length; j++) { try { ufns[j](tab.id, { status: "complete", url: tab.url, title: tab.title }, tab); } catch (e) {} }
            } catch (e) {}
            return JSON.stringify({ c: (self.__syTabCreatedFns || []).length });
        })()`;
        const r = await this.evalInSw(ext, expr);
        if (r.err) return { err: r.err };
        // onCreated 监听数为 0 = 扩展 app 尚未初始化（TabsApi.start 未跑）→ 喂了白喂，重试
        try {
            let parsed = JSON.parse(String(r.value));
            let tries = 0;
            while (parsed && parsed.c === 0 && tries < 4) {
                tries++;
                await new Promise((res) => setTimeout(res, 1500));
                const r2 = await this.evalInSw(ext, expr);
                if (r2.err) return { err: r2.err };
                parsed = JSON.parse(String(r2.value));
            }
        } catch {}
        return { data: "ok" };
    }

    /** popup 世界 tabs.sendMessage → content 世界的 onMessage 监听器直调 */    private async dispatchToContentWorld(ext: ICsExtInfo, args: any): Promise<{ data?: any; err?: string }> {
        const ctxId = this.contentWorlds.get(ext.electronId);
        if (!ctxId) return { data: undefined }; // 内容世界未就绪（页面刚导航？）——按无接收方回调 undefined
        const msgJson = JSON.stringify(args.msg === undefined ? null : args.msg);
        const senderJson = JSON.stringify({
            tab: { id: typeof args.tabId === "number" ? args.tabId : 1 },
            url: String(args.senderUrl || "").slice(0, 300),
        });
        const r = await this.send(
            "Runtime.evaluate",
            {
                expression: `(async () => {
                    const fns = self.__syCsOnMessageFns || [];
                    if (!fns.length) return JSON.stringify({ __noReceivers: true });
                    return await new Promise((resolve) => {
                        let done = false;
                        const finish = (v) => {
                            if (done) return;
                            done = true;
                            clearTimeout(timer);
                            resolve(JSON.stringify(v === undefined ? null : v));
                        };
                        const timer = setTimeout(() => finish(null), 25000);
                        let asyncWait = false;
                        const sendResponse = (resp) => finish(resp);
                        // handler 返回 Promise（async 函数）→ 等其 resolve 作为响应
                        const useValue = (v) => { if (v !== undefined) finish(v); };
                        for (const fn of fns) {
                            try {
                                const r = fn(${msgJson}, ${senderJson}, sendResponse);
                                if (r === true) {
                                    asyncWait = true;
                                } else if (r !== undefined) {
                                    if (typeof r.then === "function") {
                                        asyncWait = true;
                                        r.then(useValue, () => finish(undefined));
                                    } else {
                                        finish(r);
                                        break;
                                    }
                                }
                            } catch (e) {}
                        }
                        if (!asyncWait && !done) finish(undefined);
                    });
                })()`,
                contextId: ctxId,
                returnByValue: true,
                awaitPromise: true,
            },
            30000
        );
        if ((r as any)?.exceptionDetails) {
            return { err: String((r as any).exceptionDetails?.exception?.description || "content world 派发异常").slice(0, 200) };
        }
        try {
            const parsed = JSON.parse(String((r as any)?.result?.value));
            if (parsed && parsed.__noReceivers) return { data: undefined };
            return { data: parsed === null ? undefined : parsed };
        } catch {
            return { data: undefined };
        }
    }

    /** 在指定执行上下文里 evaluate（供 popup 世界等复用）。
     *  超大表达式分块传输：实测 1.8MB 的 expression 经 debugger 通道会静默无效
     *  （返回 ok 但脚本未执行），分块 push 后 eval 组装可绕过。 */
    async evaluateInWorld(ctxId: number, expr: string, timeoutMs = 30000): Promise<{ ok: boolean; value?: any; error?: string }> {
        try {
            if (expr.length > 150_000) {
                await this.send("Runtime.evaluate", { expression: "self.__syBigSrc = []", contextId: ctxId }, timeoutMs);
                const CHUNK = 100_000;
                for (let i = 0; i < expr.length; i += CHUNK) {
                    const piece = expr.slice(i, i + CHUNK);
                    await this.send(
                        "Runtime.evaluate",
                        { expression: "self.__syBigSrc.push(" + JSON.stringify(piece) + ")", contextId: ctxId },
                        timeoutMs
                    );
                }
                const r: any = await this.send(
                    "Runtime.evaluate",
                    { expression: "(0, eval)(self.__syBigSrc.join(''))", contextId: ctxId, returnByValue: false, awaitPromise: false },
                    timeoutMs
                );
                if (r?.exceptionDetails) {
                    return {
                        ok: false,
                        error: String(r.exceptionDetails?.exception?.description || r.exceptionDetails?.text || "执行异常").slice(0, 300),
                    };
                }
                return { ok: true };
            }
            const r: any = await this.send(
                "Runtime.evaluate",
                { expression: expr, contextId: ctxId, returnByValue: true, awaitPromise: true },
                timeoutMs
            );
            if (r?.exceptionDetails) {
                return {
                    ok: false,
                    error: String(r.exceptionDetails?.exception?.description || r.exceptionDetails?.text || "执行异常").slice(0, 300),
                };
            }
            return { ok: true, value: r?.result?.value };
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e) };
        }
    }

    /** 重新取主框架 id（导航后 frameId 会变） */
    async refreshFrameId(): Promise<void> {
        const tree: any = await this.send("Page.getFrameTree");
        this.frameId = tree?.frameTree?.frame?.id || tree?.frame?.id || null;
    }

    /** 探测执行上下文是否可用（写入 + 读回） */
    async probeWorld(ctxId: number): Promise<boolean> {
        try {
            await this.send("Runtime.evaluate", { expression: "self.__syWorldProbe = 1", contextId: ctxId }, 8000);
            const r: any = await this.send(
                "Runtime.evaluate",
                { expression: "self.__syWorldProbe === 1", contextId: ctxId, returnByValue: true },
                8000
            );
            return r?.result?.value === true;
        } catch {
            return false;
        }
    }

    /** 当前 popup 世界的 contextId（未 begin 时返回 null） */
    currentPopupCtx(electronId: string): number | null {
        return this.popupWorldByExt.get(electronId) || null;
    }

    /** 确保扩展的 popup 世界（★ 每次打开面板都新建 —— 世界跨打开持久会让旧垫片/旧声明残留），返回 contextId */
    async ensurePopupWorld(ext: ICsExtInfo): Promise<number> {
        if (!this.alive || !this.frameId) throw new Error("CDP 会话未就绪");
        const r: any = await this.send("Page.createIsolatedWorld", {
            frameId: this.frameId,
            worldName: POPUP_WORLD_PREFIX + ext.electronId + "-" + Date.now().toString(36),
            grantUniversalAccess: true,
            allowCommandLineAPI: false,
        });
        const ctxId = r?.executionContextId;
        if (!ctxId) throw new Error("createIsolatedWorld 未返回 contextId");
        this.popupWorldByExt.set(ext.electronId, ctxId);
        this.popupCtxs.set(ctxId, ext.electronId);
        await this.send("Runtime.addBinding", { name: BRIDGE_NAME, executionContextId: ctxId });
        const shim = buildShim(ext, this.host.messages(ext.path, ext.defaultLocale));
        const sr: any = await this.send("Runtime.evaluate", { expression: shim, contextId: ctxId, returnByValue: false });
        if (sr?.exceptionDetails) {
            throw new Error("popup 垫片执行异常: " + String(sr.exceptionDetails?.exception?.description || sr.exceptionDetails?.text).slice(0, 200));
        }
        return ctxId;
    }

    /**
     * flat 版 isolated world 直调（无 --remote-debugging-port 也可用）：
     * Target.getTargets 按 URL 找页面 target → attachToTarget{flatten} →
     * 该 flat session 里 Runtime.enable（会重放 executionContextCreated，
     * 事件经 debugger "message" 事件带 sessionId 到达）→ 按
     * __syCsRt_<electronId> 前缀（cs-runtime 自建世界）或 isolated+origin
     * 匹配 contextId → Runtime.evaluate。用完 detachFromTarget 清理。
     */
    async evalInExtensionWorldFlat(electronId: string, expr: string): Promise<{ ok: boolean; value?: any; error?: string; contextId?: number }> {
        const pageUrl = this.pageUrl;
        const norm = (u: string) => String(u || "").split("#")[0];
        let sid: string | null = null;
        let handler: ((_e: any, method: string, params: any, evtSid?: string) => void) | null = null;
        try {
            const r = await this.send("Target.getTargets");
            const infos: any[] = (r && r.targetInfos) || [];
            const pages = infos.filter((t) => t.type === "webview" || t.type === "page" || t.type === "iframe");
            const page = pages.find((t) => norm(t.url) === norm(pageUrl))
                || pages.find((t) => pageUrl && norm(t.url) === norm(pageUrl.split("?")[0]));
            if (!page) return { ok: false, error: "未找到页面 CDP target" };
            const a: any = await this.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
            sid = a && a.sessionId;
            if (!sid) return { ok: false, error: "attachToTarget 未返回 sessionId" };

            let extContextId: number | null = null;
            handler = (_e: any, method: string, params: any, evtSid?: string) => {
                if (evtSid !== sid || method !== "Runtime.executionContextCreated") return;
                const c = params?.context || {};
                const isIsolated = c.type === "isolated" || (c.auxData && c.auxData.type === "isolated");
                if (String(c.name || "").indexOf(CS_WORLD_PREFIX) === 0) {
                    // 自建世界优先 —— Electron 原生世界的 CS 已因空壳 chrome 抛错
                    if (c.name.slice(CS_WORLD_PREFIX.length) === electronId) extContextId = c.id;
                    return;
                }
                if (isIsolated && String(c.origin || "").includes(electronId)) extContextId = c.id;
            };
            this.wc.debugger.on("message", handler);
            await this.send("Runtime.enable", {}, 8000, sid);
            // 上下文事件可能未及时到达，轮询等待
            for (let i = 0; i < 20 && extContextId === null; i++) {
                await new Promise((r2) => setTimeout(r2, 200));
            }
            if (extContextId === null) {
                return { ok: false, error: "该页面没有此扩展的运行时世界（页面未加载完成或 cs-runtime 未就绪）" };
            }
            const er: any = await this.send(
                "Runtime.evaluate",
                { expression: expr, returnByValue: true, awaitPromise: true, contextId: extContextId },
                15000,
                sid
            );
            if (er && er.exceptionDetails) {
                return {
                    ok: false,
                    error: String(er.exceptionDetails?.exception?.description || er.exceptionDetails?.text || "isolated world 执行异常").slice(0, 300),
                    contextId: extContextId,
                };
            }
            return { ok: true, value: er && er.result ? er.result.value : null, contextId: extContextId };
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e) };
        } finally {
            if (handler) {
                try { this.wc.debugger.off("message", handler); } catch {}
            }
            if (sid) {
                try { this.send("Target.detachFromTarget", { sessionId: sid }, 3000, sid); } catch {}
            }
        }
    }

    async evalInSw(ext: ICsExtInfo, expr: string): Promise<{ value?: any; err?: string }> {
        let eid = ext.electronId;
        // HTTP CDP 熔断生效时直接走进程内 flat 通道（正常启动无 --remote-debugging-port）。
        // ★ 唤醒只允许发生在对应通道内部：flat 路径绝不能先 wakeOne —— 会把已预热的
        //    SW remove+load 重启，扩展 app 重新初始化，popup 首开必撞空 handler。
        let target = cdpHttpLikelyDead() ? null : await findSwTarget(eid);
        if (!target && !cdpHttpLikelyDead()) {
            // HTTP 通道存在但 SW 休眠 → 无副作用唤醒（★避免 remove+load 杀面板世界），
            // 仍找不到才走 wakeOne（全量重载 + id 同步）
            const wakeA = this.host.wakeSw
                ? async () => { await this.host.wakeSw!(eid); }
                : async () => { eid = (await this.host.wakeOne(eid).then((r) => (typeof r === "string" ? r : eid)).catch(() => eid)) || eid; };
            await wakeA();
            for (let i = 0; i < 10 && !target; i++) {
                await new Promise((r) => setTimeout(r, 300));
                target = await findSwTarget(eid);
            }
            if (!target && this.host.wakeSw) {
                const fresh = await this.host.wakeOne(eid).then((r) => (typeof r === "string" ? r : eid)).catch(() => eid);
                eid = fresh || eid;
                for (let i = 0; i < 10 && !target; i++) {
                    await new Promise((r) => setTimeout(r, 300));
                    target = await findSwTarget(eid);
                }
            }
        }
        if (!target) {
            // flat 通道（正常启动）：SW 活着就直接 evaluate；不活着由 flat 内部 wake。
            // ★ wake 必须无副作用（startWorkerForScope）—— remove+load 会把正在打开的
            //   面板世界连 binding 一起销毁，popup.js 首个 storage 调用永挂 → 面板全白
            const flat = await evalInSwFlat(
                (method, params, sessionId) => Promise.race([
                    this.wc.debugger.sendCommand(method, params, sessionId),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 12000)),
                ]),
                eid,
                expr,
                async () => {
                    if (this.host.wakeSw) await this.host.wakeSw(eid);
                    else await this.host.wakeOne(eid);
                }
            );
            if (flat.err !== SW_FLAT_UNAVAILABLE) return flat;
            const alt = await evalInSwViaMainWindow(eid, expr);
            if (alt.err !== SW_FLAT_UNAVAILABLE) return alt;
            return { err: "扩展 SW 未运行且唤醒失败（CDP 不可用？）" };
        }
        const r = await cdpEvalOnce(target.webSocketDebuggerUrl, expr, 12000);
        if (r && typeof r === "object" && r.err) return { err: String(r.err) };
        return { value: r };
    }
}

/** 主窗口 debugger 兜底（webview 会话不可用时；attach 与 DevTools 互斥，用完即 detach） */
async function evalInSwViaMainWindow(electronId: string, expr: string): Promise<{ value?: any; err?: string }> {
    let attachedHere = false;
    try {
        const req = (window as any).require;
        if (!req) return { err: SW_FLAT_UNAVAILABLE };
        const remote = req("@electron/remote");
        const wc = remote.getCurrentWebContents();
        const dbg = wc.debugger;
        if (!dbg.isAttached()) {
            dbg.attach("1.3");
            attachedHere = true;
        }
        const sender = (method: string, params?: any, sessionId?: string) =>
            Promise.race([
                dbg.sendCommand(method, params, sessionId),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 12000)),
            ]);
        return await evalInSwFlat(sender, electronId, expr);
    } catch (e: any) {
        // attach 失败（如用户开着 DevTools）按通道不可用处理
        void e;
        return { err: SW_FLAT_UNAVAILABLE };
    } finally {
        if (attachedHere) {
            try {
                (window as any).require("@electron/remote").getCurrentWebContents().debugger.detach();
            } catch {}
        }
    }
}

/** manager 级 SW eval（供 contextMenus 等无 webview 上下文的调用方使用）：
 *  任一存活 webview 会话的 evalInSw（HTTP→flat 双通道），没有则主窗口兜底 */
export function evalInSwBridge(ext: { electronId: string }, expr: string): Promise<{ value?: any; err?: string }> {
    if (!manager) return Promise.resolve({ err: "cs-runtime 未初始化" });
    return manager.evalInSwAny(ext.electronId, expr);
}

/** manager 级 isolated world 直调（flat 通道，无调试端口也可用）——Clip 划词等 */
export function evalInExtensionWorldBridge(webview: IWebviewTag, electronId: string, expr: string): Promise<{ ok: boolean; value?: any; error?: string; contextId?: number }> {
    if (!manager) return Promise.resolve({ ok: false, error: "cs-runtime 未初始化" });
    return manager.evalExtensionWorldAny(webview, electronId, expr);
}

function safeUrl(webview: IWebviewTag): string {
    try {
        return webview.getURL?.() || "";
    } catch {
        return "";
    }
}

// ===== 注入到自建世界的 chrome.* 垫片 =====

function buildShim(ext: ICsExtInfo, messages: Record<string, any>): string {
    const extData = JSON.stringify({ id: ext.electronId, name: ext.name, version: ext.version });
    const messagesJson = JSON.stringify(messages || {});
    return `
(function () {
    if (window.__syCsRtShim) return;
    window.__syCsRtShim = true;
    var EXT = ${extData};
    var MESSAGES = ${messagesJson};
    var __seq = 0, __pending = {};
    window.__syExtHostResolve = function (json) {
        try {
            var r = JSON.parse(json);
            var p = __pending[r.reqId];
            if (!p) return;
            delete __pending[r.reqId];
            clearTimeout(p.timer);
            if (r.err) p.reject(new Error(r.err)); else p.resolve(r.data);
        } catch (e) {}
    };
    function hostCall(type, args) {
        return new Promise(function (resolve, reject) {
            var reqId = "q" + (++__seq) + Math.random().toString(36).slice(2, 8);
            var rec = { resolve: resolve, reject: reject, timer: 0 };
            __pending[reqId] = rec;
            rec.timer = setTimeout(function () {
                if (__pending[reqId]) { delete __pending[reqId]; reject(new Error("__syExtHost bridge timeout")); }
            }, 30000);
            try {
                window.${BRIDGE_NAME}(JSON.stringify({ reqId: reqId, type: type, args: args === undefined ? null : args }));
            } catch (e) {
                clearTimeout(rec.timer);
                delete __pending[reqId];
                reject(e);
            }
        });
    }
    function cbStyle(p, cb) {
        if (typeof cb === "function") {
            p.then(function (v) { try { cb(v); } catch (e) {} }, function () { try { cb(undefined); } catch (e) {} });
        }
        return p;
    }
    // 内核请求代理：https 页面的隔离世界 fetch http://127.0.0.1/<localhost> 是
    // mixed content，直接 "Failed to fetch"（实测 Clip 发送/笔记本列表全挂）。
    // 内核 URL 转经宿主桥，宿主用 Node http 代发（绕开浏览器 fetch 限制）。
    try {
        var oFetch = window.fetch;
        window.fetch = function (input, init) {
            try {
                var url = typeof input === "string" ? input : (input && input.url) || "";
                if (/^http:\\/\\/(127\\.0\\.0\\.1|localhost)(:\\d+)?/i.test(url)) {
                    var headers = {};
                    if (init && init.headers) {
                        if (typeof init.headers.forEach === "function") {
                            init.headers.forEach(function (v, k) { headers[k] = v; });
                        } else {
                            for (var k in init.headers) { headers[k] = init.headers[k]; }
                        }
                    }
                    return hostCall("kernelfetch", {
                        url: url,
                        method: (init && init.method) || "GET",
                        headers: headers,
                        body: (init && init.body) === undefined || (init && init.body) === null ? null : String(init.body),
                    }).then(function (r) {
                        var resp = (typeof r === "string") ? JSON.parse(r) : (r || {});
                        var st = resp.status || 0;
                        if (st < 200) throw new TypeError("Failed to fetch");
                        return new Response(resp.bodyText || "", { status: st });
                    });
                }
            } catch (e) {}
            return oFetch.apply(window, arguments);
        };
    } catch (e) {}
    // API 调用轨迹（调试扩展初始化卡点；self.__syApiLog 由宿主或探针读取）
    var __traceDepth = 0;
    function traced(name, fn) {
        return function () {
            var args = arguments;
            try { (self.__syApiLog = self.__syApiLog || []).push(new Array(__traceDepth + 1).join("  ") + name + "()"); } catch (e) {}
            __traceDepth++;
            var done = function (v) { __traceDepth--; return v; };
            var r = fn.apply(null, args);
            if (r && typeof r.then === "function") {
                return r.then(
                    function (v) { return done(v); },
                    function (e) { try { (self.__syApiLog = self.__syApiLog || []).push(new Array(__traceDepth + 1).join("  ") + name + " REJECT: " + String(e && e.message || e).slice(0, 120)); } catch (e2) {} __traceDepth--; throw e; }
                );
            }
            __traceDepth--;
            return r;
        };
    }
    // 事件存根（onConnect/onInstalled 等：扩展初始化期常直接 addListener，
    // 缺失会 TypeError "Cannot read properties of undefined (reading 'addListener')"）
    var eventHub = function () {
        var fns = [];
        return {
            addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
            removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
            hasListener: function (fn) { return fns.indexOf(fn) >= 0; },
        };
    };
    window.chrome = window.chrome || {};
    // ★ 整体替换 chrome 对象：世界里的 chrome 可能是 Electron 原生绑定
    //   （storage.local 真实可用、但访问 storage.sync 会原生抛
    //   "sync" is not available in this instance of Chrome），逐属性赋值
    //   对原生访问器会被静默忽略。整体替换后所有命名空间都是我们的实现。
    var chrome_ = {};
    chrome_.runtime = {
        id: EXT.id,
        getManifest: function () { return { manifest_version: 3, name: EXT.name, version: EXT.version }; },
        getURL: function (p) { return "chrome-extension://" + EXT.id + "/" + String(p || "").replace(/^\\//, ""); },
        onMessage: (function () {
            var fns = [];
            self.__syCsOnMessageFns = fns;
            return {
                addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
                removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
                hasListener: function (fn) { return fns.indexOf(fn) >= 0; },
            };
        })(),
        sendMessage: function (msg, cb) {
            var p = hostCall("sendmessage", { msg: msg === undefined ? null : msg, senderUrl: String(location.href).slice(0, 300) });
            return cbStyle(p, cb);
        },
        // 长连接端口：postMessage 经宿主 routePortMessage 派发到 SW 的
        // onConnect 端口处理器（垫片 v5），outbox 回包 dispatch 给本端监听器。
        // portId 跨 postMessage 复用 —— 同一 connect 会话对应 SW 里同一个 port。
        connect: traced("runtime.connect", function (info) {
            var listeners = [];
            var portId = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            var port = {
                name: (info && info.name) || "",
                sender: undefined,
                error: null,
                onMessage: {
                    addListener: function (fn) { if (typeof fn === "function") listeners.push(fn); },
                    removeListener: function (fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
                    hasListener: function (fn) { return listeners.indexOf(fn) >= 0; },
                    dispatch: function (msg) { listeners.forEach(function (fn) { try { fn(msg, port); } catch (e) {} }); },
                },
                onDisconnect: eventHub(),
                postMessage: function (msg) {
                    hostCall("portmessage", {
                        portId: portId,
                        portName: (info && info.name) || "",
                        msg: msg === undefined ? null : msg,
                        senderUrl: String(location.href).slice(0, 300),
                    }).then(function (resp) {
                        if (Array.isArray(resp)) {
                            resp.forEach(function (item) { port.onMessage.dispatch(item); });
                        } else if (resp !== undefined) {
                            port.onMessage.dispatch(resp);
                        }
                    }).catch(function () {});
                },
                disconnect: function () {},
            };
            return port;
        }),
        // 长连接/生命周期事件（AdGuard 的 MessengerCommon.connect 直接用 onConnect）
        onConnect: eventHub(),
        onConnectExternal: eventHub(),
        onInstalled: eventHub(),
        onStartup: eventHub(),
        onSuspend: eventHub(),
        onSuspendCanceled: eventHub(),
        onUpdateAvailable: eventHub(),
        onRestartRequired: eventHub(),
        onMessageExternal: eventHub(),
        getBackgroundPage: function () { return Promise.resolve(undefined); },
        openOptionsPage: function () { return Promise.resolve(); },
        setUninstallURL: function () {},
        reload: function () {},
        getPlatformInfo: function () { return Promise.resolve({ os: "win", arch: "x86-64", nacl_arch: "x86-64" }); },
    };
    function storageArea(area) {
        return {
            get: traced(area + ".get", function (keys, cb) { return cbStyle(hostCall("storage", { op: "get", area: area, payload: keys === undefined ? null : keys }), cb); }),
            set: traced(area + ".set", function (items, cb) { return cbStyle(hostCall("storage", { op: "set", area: area, payload: items === undefined ? {} : items }), cb); }),
            remove: traced(area + ".remove", function (keys, cb) { return cbStyle(hostCall("storage", { op: "remove", area: area, payload: keys === undefined ? [] : keys }), cb); }),
            clear: traced(area + ".clear", function (cb) { return cbStyle(hostCall("storage", { op: "clear", area: area, payload: null }), cb); }),
            onChanged: { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } },
        };
    }
    chrome_.storage = { local: storageArea("local"), sync: storageArea("sync"), session: storageArea("session") };
    // 全局 chrome.storage.onChanged（content.js 顶层就用它，缺失即抛 TypeError）
    chrome_.storage.onChanged = { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } };
    chrome_.i18n = {
        getMessage: function (key, args) {
            var entry = MESSAGES[key];
            var msg = entry ? (entry.message || "") : "";
            if (msg && args != null) {
                var arr = Array.isArray(args) ? args : [args];
                msg = msg.replace(/\\$(\\d+)/g, function (m, i) { return arr[Number(i) - 1] != null ? arr[Number(i) - 1] : m; });
            }
            return msg;
        },
        getUILanguage: function () { return navigator.language; },
    };
    // 通用桩工厂：任意层级的缺失成员都能继续访问/调用（方法返回 Promise<undefined>），
    // 防止 undefined.addListener 之类在扩展初始化期直接崩掉
    var PROMISE_UNDEF = function () { return Promise.resolve(undefined); };
    var STUBS = {};
    var stubFor = function (label) {
        if (!STUBS[label]) {
            try { console.warn("[sy-ext-shim] " + label + " 未实现，返回通用桩"); } catch (e) {}
            var cache = {};
            STUBS[label] = new Proxy(PROMISE_UNDEF, {
                get(_t, prop) {
                    var k = String(prop);
                    if (k === "then") return undefined; // 保持非 thenable
                    if (!cache[k]) cache[k] = stubFor(label + "." + k);
                    return cache[k];
                },
                apply: PROMISE_UNDEF,
            });
        }
        return STUBS[label];
    };
    // 命名空间包装：已实现成员原样返回，缺失成员返回通用桩
    var wrapNs = function (obj, ns) {
        return new Proxy(obj, {
            get(t, prop) {
                if (prop in t) return t[prop];
                var k = String(prop);
                if (typeof prop !== "string" || k === "toJSON") return undefined;
                return stubFor(ns + "." + k);
            },
        });
    };
    if (!chrome_.tabs) {
        chrome_.tabs = {
            // popup 的"当前标签"就是它所在的页面
            query: function (q, cb) {
                var tab = { id: 1, index: 0, windowId: 1, active: true, highlighted: true, pinned: false, incognito: false, url: String(location.href), title: document.title };
                // 顺手把该 tab 喂进 SW 的 tab 注册表（tabevent 通道）——
                // AdGuard 的 tabsApi 靠 tabs 事件建 tabContext，Electron 下事件
                // 缺失，不喂的话 getTabContext 恒 undefined → popup 卡 loading
                try { hostCall("tabevent", { url: tab.url, title: tab.title }).catch(function () {}); } catch (e) {}
                return cbStyle(Promise.resolve([tab]), cb);
            },
            // 派发到本扩展 content 世界的 onMessage 监听器（宿主中转；SW↔CS 路由缺失的替代）
            sendMessage: function (tabId, msg, cb) {
                var p = hostCall("tabs-sendmessage", { tabId: typeof tabId === "number" ? tabId : null, msg: msg === undefined ? null : msg, senderUrl: String(location.href).slice(0, 300) });
                return cbStyle(p, typeof cb === "function" ? cb : undefined);
            },
        };
    }
    if (!chrome_.dom) chrome_.dom = {};
    // 命名空间级补桩（在整体替换前完成，保证缺失事件也不炸）
    chrome_.runtime = wrapNs(chrome_.runtime, "chrome.runtime");
    chrome_.storage.local = wrapNs(chrome_.storage.local, "chrome.storage.local");
    chrome_.storage.sync = wrapNs(chrome_.storage.sync, "chrome.storage.sync");
    chrome_.storage.session = wrapNs(chrome_.storage.session, "chrome.storage.session");
    chrome_.storage = wrapNs(chrome_.storage, "chrome.storage");
    chrome_.i18n = wrapNs(chrome_.i18n, "chrome.i18n");
    chrome_.tabs = wrapNs(chrome_.tabs, "chrome.tabs");
    // 整体替换挂载（见上方注释：原生访问器属性会被静默忽略，必须整对象替换）。
    // 外层 Proxy：访问未实现的命名空间时返回通用桩（缺失成员可继续嵌套访问/调用），
    // 让重度扩展（如 AdGuard 引用 declarativeNetRequest）不至于在启动期崩掉。
    // 注意：__esModule / default / then / toJSON 必须返回 undefined —— 否则 webpack/rspack
    // 的 ESM interop 会把 chrome 当成 ES 模块（truthy）而去取 chrome.default.runtime → 崩。
    window.chrome = new Proxy(chrome_, {
        get(target, prop) {
            if (prop in target) return target[prop];
            const key = String(prop);
            // ESM interop / 序列化探针：必须保持 falsy，不能返回通用桩
            if (typeof prop !== "string" || key === "__esModule" || key === "default" || key === "then" || key === "toJSON") return undefined;
            return stubFor("chrome." + key);
        },
    });
    // Firefox 风格的 browser.* 命名空间别名（跨浏览器扩展常用；缺了会
    // "Cannot read properties of undefined (reading 'runtime')"）
    try { self.browser = window.chrome; } catch (e) {}
})();
`;
}

