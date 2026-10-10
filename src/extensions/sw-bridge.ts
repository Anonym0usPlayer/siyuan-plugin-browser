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

function nodeHttp(): typeof import("http") {
    const req = (window as any).require;
    if (!req) throw new Error("node require unavailable");
    return req("http");
}

/** 拉取 CDP target 列表（Node http 绕开页面 CORS） */
function fetchTargets(): Promise<Array<Record<string, any>>> {
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

async function findSwTarget(electronId: string): Promise<ISwTarget | null> {
    try {
        const targets = await fetchTargets();
        const hit = targets.find((t) => t.type === "service_worker" && String(t.url).includes(electronId));
        return hit ? ({ id: hit.id, url: String(hit.url), webSocketDebuggerUrl: hit.webSocketDebuggerUrl } as ISwTarget) : null;
    } catch {
        return null;
    }
}

/** 一次性 CDP WebSocket 会话：连上后执行 expr，返回结果值 */
function cdpEvalOnce(wsUrl: string, expr: string, timeoutMs = 8000): Promise<any> {
    return new Promise((resolve) => {
        let ws: WebSocket;
        try {
            ws = new WebSocket(wsUrl);
        } catch (e: any) {
            resolve({ err: `WebSocket 创建失败: ${String(e?.message || e)}` });
            return;
        }
        let s = 0;
        const pending = new Map<number, (r: any) => void>();
        ws.onmessage = (ev) => {
            const m = JSON.parse(String(ev.data));
            if (m.id && pending.has(m.id)) {
                const fn = pending.get(m.id);
                pending.delete(m.id);
                fn?.(m);
            }
        };
        const send = (method: string, params: any = {}) => new Promise<any>((res) => {
            const i = ++s;
            pending.set(i, res);
            ws.send(JSON.stringify({ id: i, method, params }));
        });
        const finish = (v: any) => {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve(v);
        };
        const timer = setTimeout(() => finish({ err: "CDP 会话超时" }), timeoutMs);
        ws.onopen = async () => {
            try {
                await send("Runtime.enable");
                const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
                if (r.result?.exceptionDetails) {
                    finish({ err: String(r.result.exceptionDetails?.exception?.description || r.result.exceptionDetails.text || "SW 执行异常").slice(0, 300) });
                } else {
                    finish(r.result?.result?.value ?? null);
                }
            } catch (e: any) {
                finish({ err: String(e?.message || e) });
            }
        };
        ws.onerror = () => finish({ err: "WebSocket 连接失败" });
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
        let ws: WebSocket;
        try {
            ws = new WebSocket(page.webSocketDebuggerUrl);
        } catch (e: any) {
            resolve({ ok: false, error: `WebSocket 失败: ${String(e?.message || e)}` });
            return;
        }
        let s = 0;
        const pending = new Map<number, (r: any) => void>();
        let extContextId: number | null = null;
        ws.onmessage = (ev) => {
            let m: any;
            try { m = JSON.parse(String(ev.data)); } catch { return; }
            if (m.method === "Runtime.executionContextCreated") {
                const c = m.params?.context || {};
                const origin = String(c.origin || "");
                // isolated 标记在 auxData.type，c.type 在部分 Chromium 版本上为空（实测踩过）
                const isIsolated = c.type === "isolated" || (c.auxData && c.auxData.type === "isolated");
                if (isIsolated && origin.includes(electronId)) {
                    extContextId = c.id;
                }
            }
            if (m.id && pending.has(m.id)) {
                const fn = pending.get(m.id);
                pending.delete(m.id);
                fn?.(m);
            }
        };
        const finish = (v: any) => {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve(v);
        };
        const send = (method: string, params: any = {}) => new Promise<any>((res) => {
            const i = ++s;
            pending.set(i, res);
            ws.send(JSON.stringify({ id: i, method, params }));
        });
        const timer = setTimeout(() => finish({ ok: false, error: "CDP 会话超时" }), 10000);
        ws.onopen = async () => {
            try {
                await send("Runtime.enable");
                // 上下文事件可能未及时到达，重试等待
                for (let i = 0; i < 10 && extContextId === null; i++) {
                    await new Promise((r2) => setTimeout(r2, 200));
                }
                if (extContextId === null) {
                    finish({ ok: false, error: "该页面没有此扩展的 isolated world（content script 未注入？）" });
                    return;
                }
                const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, contextId: extContextId });
                if (r.result?.exceptionDetails) {
                    finish({ ok: false, error: String(r.result.exceptionDetails?.exception?.description || r.result.exceptionDetails.text || "isolated world 执行异常").slice(0, 300), contextId: extContextId });
                } else {
                    finish({ ok: true, value: r.result?.result?.value, contextId: extContextId });
                }
            } catch (e: any) {
                finish({ ok: false, error: String(e?.message || e) });
            }
        };
        ws.onerror = () => finish({ ok: false, error: "WebSocket 连接失败" });
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
