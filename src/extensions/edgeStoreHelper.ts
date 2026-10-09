/**
 * Edge 加载项商店页内助手（注入到 webview 页面主世界执行）。
 *
 * 在商店详情页（/addons/detail/<slug>/<id>）右下角悬浮一个"安装到思源"按钮，
 * 点击后把扩展 id 送回宿主（extensionHost.installFromEdgeAddons），
 * 不依赖商店自己的"获取"按钮在非 Edge 环境下的行为。
 *
 * 页面 → 宿主通道（双保险，按可用性择一）：
 * 1. preload 桥（优先）：window.__browserPluginPreloadInjected 为真时，
 *    dispatch CustomEvent("sy-browser-host")，preload.js 白名单转发 sendToHost
 * 2. 轮询兜底：写入 window.__syEdgeInstall，由 WebviewController 的 300ms 轮询消费并清除
 *
 * SPA 路由（React Router）监听：800ms 轮询 location.pathname，
 * 离开详情页自动隐藏按钮，进入新的详情页重新绑定 id。
 * 宿主可通过 window.__syEdgeStoreSetState("installing"|"ok"|"idle") 回写按钮状态。
 */

export interface IEdgeStoreHelperLabels {
    install: string;
    installing: string;
    installed: string;
}

/** 当前 URL 是否为 Edge 加载项商店（注入前快速过滤） */
export function isEdgeAddonsSiteUrl(url: string): boolean {
    return /^https?:\/\/microsoftedge\.microsoft\.com\//i.test(String(url || ""));
}

export function buildEdgeStoreHelperScript(labels: IEdgeStoreHelperLabels): string {
    const L = JSON.stringify(labels);
    return `
(function () {
    if (window.__syEdgeStoreHelper) return;
    window.__syEdgeStoreHelper = true;

    var LABELS = ${L};
    var currentId = null;
    var btn = null;
    var state = "idle";

    // 从当前路由解析扩展 id（详情页 /addons/detail/<slug>/<id>）
    function idFromLocation() {
        var m = location.pathname.match(/\\/addons\\/detail\\/(?:[^/]+\\/)?([a-p]{32})/i);
        return m ? m[1].toLowerCase() : null;
    }

    function applyState() {
        if (!btn) return;
        if (state === "installing") {
            btn.textContent = LABELS.installing;
            btn.style.opacity = "0.75";
            btn.style.pointerEvents = "none";
        } else if (state === "ok") {
            btn.textContent = LABELS.installed;
            btn.style.opacity = "1";
            btn.style.pointerEvents = "auto";
        } else {
            btn.textContent = LABELS.install;
            btn.style.opacity = "1";
            btn.style.pointerEvents = "auto";
        }
    }

    // 宿主回写状态（安装中/成功/复位）
    window.__syEdgeStoreSetState = function (s) {
        state = s === "installing" || s === "ok" ? s : "idle";
        applyState();
    };

    function sendInstall(id) {
        state = "installing";
        applyState();
        if (window.__browserPluginPreloadInjected) {
            try {
                window.dispatchEvent(new CustomEvent("sy-browser-host", {
                    detail: { type: "browser-edge-install", payload: { id: id } },
                }));
                return;
            } catch (e) {}
        }
        // preload 缺失：轮询兜底（宿主消费后清除）
        window.__syEdgeInstall = id;
    }

    function ensureButton() {
        var id = idFromLocation();
        if (!id) {
            if (btn) btn.style.display = "none";
            currentId = null;
            return;
        }
        if (!btn) {
            btn = document.createElement("div");
            btn.setAttribute("role", "button");
            btn.setAttribute("data-sy-edge-install", "1");
            btn.style.cssText = [
                "position:fixed", "bottom:24px", "right:24px", "z-index:2147483647",
                "padding:9px 16px", "border-radius:20px", "cursor:pointer",
                "background:#0f6cbd", "color:#fff", "font-size:13px", "font-weight:600",
                "font-family:inherit", "line-height:1", "user-select:none",
                "box-shadow:0 2px 8px rgba(0,0,0,.3)", "border:1px solid rgba(255,255,255,.25)",
            ].join(";");
            btn.addEventListener("click", function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                if (state === "installing") return;
                if (currentId) sendInstall(currentId);
            });
            (document.body || document.documentElement).appendChild(btn);
        }
        if (currentId !== id) {
            currentId = id;
            state = "idle";
            btn.style.display = "block";
            applyState();
        }
    }

    // SPA 路由跟随（React Router 无原生事件可用，轻量轮询足够）
    setInterval(ensureButton, 800);
    ensureButton();
})();
`;
}
