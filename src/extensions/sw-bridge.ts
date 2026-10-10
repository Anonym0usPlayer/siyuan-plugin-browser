/**
 * 宿主 ↔ 扩展 Service Worker 的触发桥。
 *
 * 背景见 extensionHost.injectBackgroundShims：Electron 下扩展 SW 可启动
 * （垫片补齐缺失 API），但 contextMenus 没有真实注册到任何 UI —— 菜单
 * 点击事件只能由外部模拟。桥的两半：
 *
 * 1. 找 SW：MV3 SW 空闲即休眠，CDP targets/getAllRunning 里常常不在。
 *    唤醒手段：removeExtension + loadExtension（触发 onInstalled，
 *    垫片 v3 会补发它 → 扩展重新注册菜单）。
 * 2. 触发点击：CDP Runtime.evaluate 调垫片暴露的
 *    self.__syContextMenuStore.click.__emit(info, tab)，
 *    handler 内部走官方 chrome.tabs.sendMessage → content script。
 *
 * 通道为什么是 CDP：宿主与 SW 之间没有任何常规消息通道（页面 world 的
 * chrome.storage 不存在、runtime.sendMessage 需要 externally_connectable、
 * storage 隔离按扩展划分）。CDP 端口只在 --remote-debugging-port 开启时
 * 可用 —— 当前是开发者场景；普通用户需要后续换 storage 桥或原生实现。
 *
 * CDP HTTP 端点（/json/list）不带 CORS 头，页面 fetch 读不了响应，
 * 所以用 Node http（nodeIntegration 渲染进程可 require）拿列表；
 * 命令通道用原生 WebSocket（ws:// 不受 CORS 限制）。
 */
import type { IWebviewTag } from "../types";

const CDP_HTTP = "http://127.0.0.1:9222";

interface ISwTarget {
    id: string;
    url: string;
    webSocketDebuggerUrl: string;
}

/** 扩展 CS 运行时（cs-runtime.ts）自建 isolated world 的命名前缀 */
export const CS_WORLD_PREFIX = "__syCsRt_";

function nodeHttp(): typeof import("http") {
    const req = (window as any).require;
    if (!req) throw new Error("node require unavailable");
    return req("http");
}

function nodeRequire(mod: string): any {
    const req = (window as any).require;
    if (!req) throw new Error("node require unavailable");
    return req(mod);
}

// ===== 最小 Node WebSocket 客户端（RFC6455 over http upgrade） =====
//
// 渲染进程的浏览器 WebSocket 连 ws://127.0.0.1:9222 会被 https 页面的混合内容
// 策略拦截（实测 error，无详细原因）—— nodeIntegration 下用 Node http 发
// Upgrade 握手 + 手写帧编解码，绕开该限制。支持：文本帧收发、分片聚合、
// ping/pong、关闭帧；CDP 场景够用。

function wsEncodeClientFrame(payload: Buffer, opcode = 0x1): Buffer {
    const crypto = nodeRequire("crypto");
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([header, mask, masked]);
}

function wsDecodeServerFrame(buf: Buffer): { opcode: number; fin: boolean; payload: Buffer; consumed: number } | null {
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const opcode = b0 & 0x0f;
    const fin = (b0 & 0x80) !== 0;
    const isMasked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
        if (buf.length < 4) return null;
        len = buf.readUInt16BE(2);
        offset = 4;
    } else if (len === 127) {
        if (buf.length < 10) return null;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
    }
    if (len > 64 * 1024 * 1024) return null; // 64MB 防御
    const maskLen = isMasked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return null;
    let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
    if (isMasked) {
        const mask = buf.subarray(offset, offset + 4);
        const un = Buffer.alloc(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i % 4];
        payload = un;
    }
    return { opcode, fin, payload, consumed: offset + maskLen + len };
}

export interface INodeWsSession {
    send: (method: string, params?: any) => Promise<any>;
    onMessage: (fn: (m: any) => void) => void;
    close: () => void;
}

/** 连接 CDP WebSocket（Node http upgrade 实现），提供 send/onMessage/close */
export function nodeWsSession(wsUrl: string, timeoutMs = 10000): Promise<INodeWsSession> {
    return new Promise((resolve, reject) => {
        try {
            const crypto = nodeRequire("crypto");
            const u = new URL(wsUrl);
            const lib = u.protocol === "wss:" ? nodeRequire("https") : nodeHttp();
            const req = lib.request({
                hostname: u.hostname,
                port: u.port || (u.protocol === "wss:" ? 443 : 80),
                path: u.pathname + (u.search || ""),
                headers: {
                    Host: u.host,
                    Upgrade: "websocket",
                    Connection: "Upgrade",
                    "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
                    "Sec-WebSocket-Version": "13",
                },
            });
            const timer = setTimeout(() => {
                try {
                    req.destroy();
                } catch (e) {}
                reject(new Error("ws upgrade 超时"));
            }, timeoutMs);
            req.on("response", (res: any) => {
                clearTimeout(timer);
                reject(new Error("ws upgrade 被拒: HTTP " + res.statusCode));
            });
            req.on("error", (e: any) => {
                clearTimeout(timer);
                reject(new Error("ws upgrade 失败: " + (e?.message || e)));
            });
            req.on("upgrade", (res: any, socket: any) => {
                clearTimeout(timer);
                socket.setNoDelay(true);
                let buf = Buffer.alloc(0);
                let frag: { chunks: Buffer[] } | null = null;
                const listeners: Array<(m: any) => void> = [];
                let seq = 0;
                const pending = new Map<number, (m: any) => void>();
                const dispatchText = (payload: Buffer) => {
                    let m: any;
                    try {
                        m = JSON.parse(payload.toString("utf8"));
                    } catch {
                        return;
                    }
                    if (m.id && pending.has(m.id)) {
                        const fn = pending.get(m.id);
                        pending.delete(m.id);
                        fn(m);
                        return;
                    }
                    listeners.forEach((fn) => {
                        try {
                            fn(m);
                        } catch (e) {}
                    });
                };
                socket.on("data", (d: Buffer) => {
                    buf = Buffer.concat([buf, d]);
                    for (;;) {
                        const f = wsDecodeServerFrame(buf);
                        if (!f) break;
                        buf = buf.subarray(f.consumed);
                        if (f.opcode === 0x8) {
                            try {
                                socket.end();
                            } catch (e) {}
                            return;
                        }
                        if (f.opcode === 0x9) {
                            try {
                                socket.write(wsEncodeClientFrame(f.payload, 0xa));
                            } catch (e) {}
                            continue;
                        }
                        if (f.opcode === 0x0) {
                            if (frag) {
                                frag.chunks.push(f.payload);
                                if (f.fin) {
                                    dispatchText(Buffer.concat(frag.chunks));
                                    frag = null;
                                }
                            }
                            continue;
                        }
                        if (f.fin) dispatchText(f.payload);
                        else frag = { chunks: [f.payload] };
                    }
                });
                socket.on("error", () => {});
                const api: INodeWsSession = {
                    send: (method: string, params: any = {}) =>
                        new Promise<any>((res, rej) => {
                            const id = ++seq;
                            const t = setTimeout(() => {
                                pending.delete(id);
                                rej(new Error("cdp timeout: " + method));
                            }, 15000);
                            pending.set(id, (m) => {
                                clearTimeout(t);
                                m.error ? rej(new Error(m.error.message || "cdp error")) : res(m.result);
                            });
                            try {
                                socket.write(wsEncodeClientFrame(Buffer.from(JSON.stringify({ id, method, params }), "utf8")));
                            } catch (e: any) {
                                clearTimeout(t);
                                pending.delete(id);
                                rej(new Error("ws send 失败: " + (e?.message || e)));
                            }
                        }),
                    onMessage: (fn) => listeners.push(fn),
                    close: () => {
                        try {
                            socket.end();
                        } catch (e) {}
                    },
                };
                resolve(api);
            });
            req.end();
        } catch (e: any) {
            reject(new Error(String(e?.message || e)));
        }
    });
}

/** 拉取 CDP target 列表（Node http 绕开页面 CORS） */
export function fetchTargets(): Promise<Array<Record<string, any>>> {
    return new Promise((resolve, reject) => {
        try {
            const http = nodeHttp();
            const req = http.get(`${CDP_HTTP}/json/list`, { timeout: 4000 }, (res) => {
                let data = "";
                res.on("data", (c) => { data += c; });
                res.on("end", () => {
                    try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("CDP 响应解析失败")); }
                });
            });
            req.on("error", (e) => reject(new Error(`CDP 不可达（需 --remote-debugging-port 启动思源）: ${e.message}`)));
            req.on("timeout", () => { req.destroy(); reject(new Error("CDP 请求超时")); });
        } catch (e: any) {
            reject(new Error(String(e?.message || e)));
        }
    });
}

/** SW target 的 origin id 可能与扩展 id 不是同一套（Electron 生成机制未文档化，实测两者会不一致）——
 *  URL 快速匹配失败时逐个 SW evaluate chrome.runtime.id 确认，结果按 targetId 缓存 */
const swRuntimeIdCache = new Map<string, string>(); // targetId → runtimeId

export async function findSwTarget(electronId: string): Promise<ISwTarget | null> {
    try {
        const targets = await fetchTargets();
        const sws = targets.filter((t) => t.type === "service_worker" || t.type === "background_page");
        const asTarget = (t: any): ISwTarget => ({ id: t.id, url: String(t.url), webSocketDebuggerUrl: t.webSocketDebuggerUrl });
        // 1. 缓存命中（target 仍在列表）
        for (const t of sws) {
            if (swRuntimeIdCache.get(t.id) === electronId) return asTarget(t);
        }
        // 2. URL 快速匹配
        const byUrl = sws.find((t) => String(t.url).includes(electronId));
        if (byUrl) {
            swRuntimeIdCache.set(byUrl.id, electronId);
            return asTarget(byUrl);
        }
        // 3. 逐个探测 chrome.runtime.id（SW origin id 可能与扩展 id 不是同一套）
        for (const t of sws) {
            try {
                const r = await cdpEvalOnce(t.webSocketDebuggerUrl, "chrome.runtime.id", 4000);
                const rid = typeof r === "string" ? r : r && (r as any).id;
                if (rid) {
                    swRuntimeIdCache.set(t.id, String(rid));
                    if (String(rid) === electronId) return asTarget(t);
                }
            } catch (e) {}
        }
        return null;
    } catch {
        return null;
    }
}

/** 一次性 CDP WebSocket 会话：连上后执行 expr，返回结果值（Node WS，浏览器 WS 被混合内容拦截） */
export function cdpEvalOnce(wsUrl: string, expr: string, timeoutMs = 8000): Promise<any> {
    return new Promise((resolve) => {
        void (async () => {
            let ws: INodeWsSession | null = null;
            const finish = (v: any) => {
                clearTimeout(timer);
                try {
                    ws?.close();
                } catch (e) {}
                resolve(v);
            };
            const timer = setTimeout(() => finish({ err: "CDP 会话超时" }), timeoutMs);
            try {
                ws = await nodeWsSession(wsUrl, 8000);
                await ws.send("Runtime.enable");
                const r = await ws.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
                if (r?.exceptionDetails) {
                    finish({ err: String(r.exceptionDetails?.exception?.description || r.exceptionDetails?.text || "SW 执行异常").slice(0, 300) });
                } else {
                    finish(r?.result?.value ?? null);
                }
            } catch (e: any) {
                finish({ err: String(e?.message || e) });
            }
        })();
    });
}

export interface IExtMenuBridge {
    /** 需要 remoteSession 做 remove/loadExtension 唤醒 */
    wakeUp: () => Promise<void>;
}

/**
 * 列出扩展在 SW 里注册的 contextMenus 项（垫片 store）。
 * SW 休眠时自动唤醒。返回 [{id, title}]；不可用（无 CDP/无垫片）返回空数组。
 */
export async function listExtensionMenuItems(ext: { electronId: string; path: string }, bridge: IExtMenuBridge): Promise<Array<{ id: string; title: string }>> {
    try {
        let target = await findSwTarget(ext.electronId);
        if (!target) {
            await bridge.wakeUp();
            // 唤醒后 SW 启动需要一点时间
            for (let i = 0; i < 10 && !target; i++) {
                await new Promise((r) => setTimeout(r, 300));
                target = await findSwTarget(ext.electronId);
            }
        }
        if (!target) return [];
        const r = await cdpEvalOnce(target.webSocketDebuggerUrl, `(() => {
            try {
                const store = self.__syContextMenuStore;
                if (!store) return { err: "no-shim" };
                const items = Object.values(store.items).map((x) => ({ id: x.id, title: x.title || x.id }));
                return { items };
            } catch (e) { return { err: String(e) }; }
        })()`);
        if (r && Array.isArray(r.items)) return r.items;
        return [];
    } catch {
        return [];
    }
}

/**
 * 模拟 contextMenus 点击：在 SW 里触发垫片的 onClicked handlers。
 * handler 内部走官方 chrome.tabs.sendMessage，content script 能收到。
 */
export async function triggerExtensionMenuClick(
    ext: { electronId: string; path: string },
    opts: { menuItemId: string; srcUrl?: string; pageUrl: string },
    bridge: IExtMenuBridge,
): Promise<{ ok: boolean; error?: string }> {
    try {
        let target = await findSwTarget(ext.electronId);
        if (!target) {
            await bridge.wakeUp();
            for (let i = 0; i < 10 && !target; i++) {
                await new Promise((r) => setTimeout(r, 300));
                target = await findSwTarget(ext.electronId);
            }
        }
        if (!target) {
            return { ok: false, error: "扩展 SW 未运行且唤醒失败（CDP 不可用？）" };
        }
        const payload = JSON.stringify({ menuItemId: opts.menuItemId, srcUrl: opts.srcUrl ?? null, pageUrl: opts.pageUrl });
        const r = await cdpEvalOnce(target.webSocketDebuggerUrl, `(async () => {
            try {
                const p = ${payload};
                const store = self.__syContextMenuStore;
                if (!store) return { err: "no-shim" };
                if (!store.items[p.menuItemId]) return { err: "no-item", items: Object.keys(store.items) };
                const tabs = await chrome.tabs.query({});
                // 按 URL 匹配当前页；tabs.url 缺失时退化用第一个
                let tab = tabs.find((t) => t.url && p.pageUrl && (t.url === p.pageUrl || p.pageUrl.startsWith(t.url)))
                    || tabs.find((t) => t.url && p.pageUrl && (t.url.split("#")[0] === p.pageUrl.split("#")[0]))
                    || tabs[0];
                if (!tab) return { err: "no-tab" };
                store.click.__emit({ menuItemId: p.menuItemId, srcUrl: p.srcUrl }, { id: tab.id });
                return { ok: true, tabId: tab.id };
            } catch (e) { return { err: String(e && e.stack || e).slice(0, 300) }; }
        })()`);
        if (r && r.ok) return { ok: true };
        return { ok: false, error: r?.err ? String(r.err) : "触发失败" };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
    }
}

// ===== isolated world 直调（绕过 Electron 缺失的 SW↔CS 消息路由） =====

/**
 * 在扩展 content script 的 isolated world 上下文里执行表达式。
 *
 * 这是 SW↔CS 消息路由缺失时的替代通道：Runtime.enable 会把页面里所有
 * execution context（含各扩展的 isolated world）广播出来，按 origin 匹配
 * chrome-extension://<electronId> 拿到 contextId，再带 contextId evaluate ——
 * 直接运行在 content script 的世界里，与它的变量/函数零距离。
 */
export async function evalInExtensionWorld(
    pageWebview: IWebviewTag,
    electronId: string,
    expr: string,
): Promise<{ ok: boolean; value?: any; error?: string; contextId?: number }> {
    const pageUrl = (() => {
        try { return pageWebview.getURL(); } catch { return ""; }
    })();
    // webview 元素不是 CDP target；从 /json/list 按 URL 找对应页面 target
    let page: any = null;
    try {
        const targets = await fetchTargets();
        const norm = (u: string) => String(u || "").split("#")[0];
        page = targets.find((t) => t.type === "webview" && norm(t.url) === norm(pageUrl))
            || targets.find((t) => t.type === "webview" && pageUrl && norm(t.url) === norm(pageUrl.split("?")[0]));
    } catch (e: any) {
        return { ok: false, error: e.message };
    }
    if (!page) return { ok: false, error: "未找到页面 CDP target" };

    return new Promise((resolve) => {
        void (async () => {
            let ws: INodeWsSession | null = null;
            let extContextId: number | null = null;
            const finish = (v: any) => {
                clearTimeout(timer);
                try {
                    ws?.close();
                } catch (e) {}
                resolve(v);
            };
            const timer = setTimeout(() => finish({ ok: false, error: "CDP 会话超时" }), 15000);
            try {
                ws = await nodeWsSession(page.webSocketDebuggerUrl, 8000);
                ws.onMessage((m) => {
                    if (m.method === "Runtime.executionContextCreated") {
                        const c = m.params?.context || {};
                        const origin = String(c.origin || "");
                        // isolated 标记在 auxData.type，c.type 在部分 Chromium 版本上为空（实测踩过）
                        const isIsolated = c.type === "isolated" || (c.auxData && c.auxData.type === "isolated");
                        // cs-runtime 自建世界（chrome.* 真实绑定）优先 —— Electron 原生世界的 CS 已因
                        // 空壳 chrome 抛错，自建世界才是可用运行时
                        if (String(c.name || "").indexOf(CS_WORLD_PREFIX) === 0) {
                            const eid = c.name.slice(CS_WORLD_PREFIX.length);
                            if (eid === electronId) extContextId = c.id;
                            return;
                        }
                        if (isIsolated && origin.includes(electronId)) {
                            extContextId = c.id;
                        }
                    }
                });
                await ws.send("Runtime.enable");
                // 上下文事件可能未及时到达，重试等待
                for (let i = 0; i < 10 && extContextId === null; i++) {
                    await new Promise((r2) => setTimeout(r2, 200));
                }
                if (extContextId === null) {
                    finish({ ok: false, error: "该页面没有此扩展的运行时世界（页面未加载完成或 cs-runtime 未就绪）" });
                    return;
                }
                const r = await ws.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, contextId: extContextId });
                if (r?.exceptionDetails) {
                    finish({ ok: false, error: String(r.exceptionDetails?.exception?.description || r.exceptionDetails?.text || "isolated world 执行异常").slice(0, 300), contextId: extContextId });
                } else {
                    finish({ ok: true, value: r?.result?.value, contextId: extContextId });
                }
            } catch (e: any) {
                finish({ ok: false, error: String(e?.message || e) });
            }
        })();
    });
}

/**
 * 把"CS↔SW 消息路由垫片"注入到扩展的 isolated world：
 * 替换 chrome.runtime.sendMessage 为 storage 桥（写 __syRouteIn 请求、
 * 监听 __syRouteResp_<id> 回包），与 SW 侧垫片 v4 的 onMessage 路由配对。
 * 幂等（__syShim 标记）；原生路由不通是前提，替换无副作用。
 */
export async function installMessageRouteShim(
    pageWebview: IWebviewTag,
    electronId: string,
): Promise<{ ok: boolean; error?: string }> {
    const r = await evalInExtensionWorld(
        pageWebview,
        electronId,
        `(() => {
            try {
                if (!chrome.runtime || !chrome.runtime.sendMessage) return { err: "no runtime.sendMessage" };
                if (chrome.runtime.sendMessage.__syShim) return { already: true };
                var shim = function (msg, callback) {
                    var reqId = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
                    var item = {};
                    item.__syRouteIn = { reqId: reqId, msg: msg === undefined ? null : msg, sender: { url: String(location.href).slice(0, 300) } };
                    chrome.storage.local.set(item);
                    if (typeof callback !== "function") return;
                    var listener = function (changes, area) {
                        if (area !== "local") return;
                        var key = "__syRouteResp_" + reqId;
                        if (changes[key]) {
                            chrome.storage.onChanged.removeListener(listener);
                            var resp = changes[key].newValue ? changes[key].newValue.resp : undefined;
                            try { callback(resp); } catch (e) {}
                            chrome.storage.local.remove(key);
                        }
                    };
                    chrome.storage.onChanged.addListener(listener);
                    setTimeout(function () { chrome.storage.onChanged.removeListener(listener); try { callback(undefined); } catch (e) {} }, 15000);
                };
                shim.__syShim = true;
                try {
                    Object.defineProperty(chrome.runtime, "sendMessage", { configurable: true, get: function () { return shim; } });
                } catch (e) {
                    chrome.runtime.sendMessage = shim;
                }
                return { installed: true };
            } catch (e) { return { err: String(e && e.stack || e).slice(0, 300) }; }
        })()`,
    );
    if (!r.ok) return { ok: false, error: r.error };
    if (r.value && r.value.err) return { ok: false, error: String(r.value.err) };
    return { ok: true };
}
