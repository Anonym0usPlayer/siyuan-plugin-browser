/**
 * 把扩展的 popup 面板注入到当前浏览的页面内展示。
 *
 * 为什么不在新标签里打开 popup.html：popup 的语义是"对当前页操作"，
 * 它靠 chrome.tabs.query({active:true}) 找目标页、再 tabs.sendMessage 发消息。
 * 单独开个标签加载 popup.html，"当前页"就成了它自己，消息永远到不了真正
 * 要操作的页面（实测 Eruda 的 Inject 按钮点了没反应就是这个原因）。
 *
 * 把 popup 的 HTML/CSS/JS 注入到目标页的 DOM 里执行就不一样了：
 * 执行上下文就是目标页本身，chrome.tabs.query 天然返回本页，
 * sendMessage 也能被本页的 content script 收到 —— 与真 Chrome 的
 * 弹窗行为一致。这也要求 webpreferences 是 contextIsolation=no
 * （本插件的 webview 正是如此），页面世界里才有 chrome 对象可用。
 */
import type { IWebviewTag } from "../types";

interface INodeMods {
    fs: typeof import("fs");
    path: typeof import("path");
}

function nodeMods(): INodeMods {
    const req = (window as any).require;
    if (!req) throw new Error("node require unavailable");
    return { fs: req("fs"), path: req("path") };
}

/** 读文本文件，不存在/读取失败返回 null */
function readText(fs: typeof import("fs"), p: string): string | null {
    try {
        if (!fs.existsSync(p)) return null;
        return fs.readFileSync(p, "utf8");
    } catch {
        return null;
    }
}

/**
 * 把 html 里的相对资源引用改写为 chrome-extension:// 绝对地址。
 * 只处理常见的属性形态；popup 一般只引用同目录的 css/js/图标。
 */
function rewriteUrls(html: string, electronId: string): string {
    const base = `chrome-extension://${electronId}/`;
    return html
        // src="xxx"、href="xxx"、src='xxx'、href='xxx'（跳过已是绝对协议的）
        .replace(/(src|href)(\s*=\s*)(["'])(?!data:|https?:|chrome-extension:)([^"']+)\3/gi,
            (_m, attr, eq, q, url) => `${attr}${eq}${q}${base}${String(url).replace(/^\.\//, "")}${q}`);
}

/**
 * 从完整 html 里取 <body>…</body> 的内容；没有 body 标签就整个返回。
 */
function extractBody(html: string): string {
    const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    return m ? m[1] : html;
}

/** 收集 html 里 <script src> 引用的本地 js 文件相对路径 */
function collectScriptSrcs(html: string): string[] {
    const out: string[] = [];
    const re = /<script[^>]*\ssrc\s*=\s*(["'])([^"']+)\1[^>]*>\s*<\/script>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
        out.push(m[2]);
    }
    return out;
}

/** 收集 html 里 <link rel=stylesheet> 引用的本地 css 文件相对路径 */
function collectCssHrefs(html: string): string[] {
    const out: string[] = [];
    const re = /<link[^>]*\srel\s*=\s*(["'])stylesheet\1[^>]*\shref\s*=\s*(["'])([^"']+)\2[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
        out.push(m[3]);
    }
    // 属性顺序相反的写法（href 在 rel 前）
    const re2 = /<link[^>]*\shref\s*=\s*(["'])([^"']+)\1[^>]*\srel\s*=\s*(["'])stylesheet\3[^>]*>/gi;
    while ((m = re2.exec(html))) {
        if (!out.includes(m[2])) out.push(m[2]);
    }
    return out;
}

/**
 * popup 世界里先执行的前奏：
 * document.body 是 Chromium 的 Unforgeable 属性（defineProperty 覆盖不了），
 * 但每个 JS 世界的 DOM 包装对象相互独立 —— 在 popup 世界给 body 的挂载方法
 * 打补丁，popup JS 的 document.body.appendChild(...) 等会重定向进面板容器
 * （有样式、随面板关闭一起移除，不污染宿主页面）；面板不在时透传真实 body。
 * 只影响 popup 世界，页面主世界 / content 世界不受影响。
 */
export const POPUP_JS_PRELUDE = `
(function () {
    if (window.__syExtPopupBodyHook) return;
    window.__syExtPopupBodyHook = true;
    function wrap() {
        var h = document.getElementById("sy-ext-popup-host");
        // 注意：__syWrap 是主世界设置的 expando，跨世界不可见；
        // 用 className（DOM attribute，跨世界共享）定位
        return h ? h.querySelector(".sy-ext-popup-wrap") : null;
    }
    var body = document.body;
    var patchMethod = function (name, redirect) {
        try {
            if (typeof body[name] !== "function") return;
            var orig = body[name].bind(body);
            Object.defineProperty(body, name, {
                configurable: true,
                value: function () {
                    var w = wrap();
                    if (!w) return orig.apply(null, arguments);
                    return redirect(w, orig, arguments);
                },
            });
        } catch (e) {}
    };
    patchMethod("appendChild", function (w, orig, args) {
        var n = args[0];
        if (n && n.nodeType === 1) { w.appendChild(n); return n; }
        return orig.apply(null, args);
    });
    patchMethod("prepend", function (w, orig, args) {
        var n = args[0];
        if (n && n.nodeType === 1) { w.prepend(n); return n; }
        return orig.apply(null, args);
    });
    patchMethod("append", function (w, orig, args) { w.append.apply(w, args); });
    patchMethod("insertBefore", function (w, orig, args) { w.insertBefore(args[0], null); return args[0]; });
    try {
        var oIAE = body.insertAdjacentHTML.bind(body);
        Object.defineProperty(body, "insertAdjacentHTML", {
            configurable: true,
            value: function (pos, html) {
                var w = wrap();
                if (!w) return oIAE(pos, html);
                w.insertAdjacentHTML(pos || "beforeend", html);
            },
        });
    } catch (e) {}
    try {
        var proto = body;
        var d = null;
        var o = proto;
        while (o && !d) { d = Object.getOwnPropertyDescriptor(o, "innerHTML"); o = Object.getPrototypeOf(o); }
        if (d && d.set) {
            Object.defineProperty(body, "innerHTML", {
                configurable: true,
                get: function () { return d.get.call(this); },
                set: function (v) {
                    var w = wrap();
                    if (!w) return d.set.call(this, v);
                    w.innerHTML = v;
                },
            });
        }
    } catch (e) {}
})();
`;

/** 括号感知的顶层逗号分割（:not(a,b) 这类不切错） */
function splitTopLevel(s: string): string[] {
    const out: string[] = [];
    let depth = 0, cur = "";
    for (const ch of s) {
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") depth--;
        if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
        else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * CSS 作用域重写：每条规则的选择器前缀 scopeSel；html/body/:root 映射为
 * scopeSel 本身；`*` 映射为 scopeSel 内的通配；@keyframes/@font-face 原样保留。
 * 让 popup.css 只作用于面板，不污染宿主页面。
 */
function scopeCss(css: string, scopeSel: string): string {
    const mapSel = (sel: string): string => {
        const parts = splitTopLevel(sel).map((t) => {
            const replaced = t.replace(/(^|[\s>+~,])(html|body|:root)(?=[\s.#[{,:]|$)/gi, (_m, pre) => pre + scopeSel);
            if (replaced !== t) return replaced;
            const star = t.replace(/(^|[\s>+~,]|\b)\*(?=[\s.#[{,:]|$)/g, (_m, pre) => pre + scopeSel + " *");
            if (star !== t) return star;
            return scopeSel + " " + t;
        });
        return parts.join(", ");
    };
    const walk = (src: string): string => {
        const out: string[] = [];
        let i = 0;
        while (i < src.length) {
            const brace = src.indexOf("{", i);
            if (brace < 0) break;
            const sel = src.slice(i, brace).trim();
            let depth = 1;
            let j = brace + 1;
            while (j < src.length && depth > 0) {
                if (src[j] === "{") depth++;
                else if (src[j] === "}") depth--;
                j++;
            }
            const body = src.slice(brace + 1, j - 1);
            i = j;
            if (/^@keyframes/i.test(sel) || /^@font-face/i.test(sel) || /^@charset/i.test(sel)) {
                out.push(sel + "{" + body + "}");
            } else if (/^@(media|supports|layer)/i.test(sel)) {
                out.push(sel + "{" + walk(body) + "}");
            } else {
                out.push(mapSel(sel) + "{" + body + "}");
            }
        }
        return out.join("\n");
    };
    return walk(css);
}

/**
 * 在目标页内展示扩展 popup。
 *
 * @param webview      目标标签的 webview
 * @param extPath      扩展解压目录（绝对路径）
 * @param electronId   Electron 侧扩展 id（拼 chrome-extension:// 资源 URL 用）
 * @param popupPath    manifest.action.default_popup 的相对路径（如 popup.html）
 * @param anchorRect   触发图标在工具栏里的位置（面板靠它的右下对齐）
 * @param evalJs       提供时：popup 的 JS 经此回调执行（推荐传 cs-runtime 的扩展
 *                     专属世界 —— 原生加载扩展在页面主世界没有可用 chrome.*）；
 *                     不提供时退回主世界内联执行（仅对不依赖 chrome 的扩展有效）
 */
export async function showExtensionPopupInPage(opts: {
    webview: IWebviewTag;
    extPath: string;
    electronId: string;
    popupPath: string;
    anchorRect?: { right: number; bottom: number };
    evalJs?: (src: string) => Promise<any>;
}): Promise<{ ok: boolean; error?: string }> {
    const { webview, extPath, electronId, popupPath, anchorRect } = opts;
    try {
        const { fs, path } = nodeMods();
        const htmlPath = path.join(extPath, popupPath);
        const html = readText(fs, htmlPath);
        if (!html) return { ok: false, error: `popup 文件不存在: ${popupPath}` };

        // 相对 popup.html 所在目录解析 css/js
        const baseDir = path.dirname(popupPath).replace(/\\/g, "/");
        const resolveRel = (rel: string): string => {
            if (/^(https?:|data:|chrome-extension:)/i.test(rel)) return rel;
            const norm = rel.replace(/^\.\//, "");
            return baseDir && baseDir !== "." ? `${baseDir}/${norm}` : norm;
        };

        const cssLinks = collectCssHrefs(html);
        const scriptSrcs = collectScriptSrcs(html).map(resolveRel);

        // css 内容内联（样式里的相对 url() 也需要重写，简化处理：只处理 chrome-extension 绝对化）。
        // light DOM 下为免 popup.css 的 body/* 全局规则污染宿主页面，做作用域重写。
        const cssBlocks: string[] = [];
        for (const rel of cssLinks) {
            const abs = path.join(extPath, resolveRel(rel));
            const css = readText(fs, abs);
            if (css) cssBlocks.push(scopeCss(rewriteUrls(css, electronId), "#sy-ext-popup-host"));
        }

        // js 源码读出后 inline 执行（executeJavaScript 的字符串里 eval）
        const jsSources: string[] = [];
        for (const rel of scriptSrcs) {
            const abs = path.join(extPath, resolveRel(rel));
            const js = readText(fs, abs);
            if (js) jsSources.push(rewriteUrls(js, electronId));
        }

        const bodyHtml = rewriteUrls(extractBody(html), electronId);

        // JS 执行通道：evalJs（扩展世界）优先；否则内联进主世界（legacy，原生加载扩展在主世界没有可用 chrome.*）
        const useEvalJs = typeof opts.evalJs === "function";
        // 组装注入脚本。所有用户内容一律 JSON.stringify 后再嵌入，避免引号/反斜杠破坏字符串。
        const payload = {
            bodyHtml,
            css: cssBlocks.join("\n"),
            js: useEvalJs ? [] : jsSources,
            anchor: anchorRect || null,
        };
        const runner = `
(function () {
    if (window.__syExtPopup) { window.__syExtPopup.close(); }
    var P = ${JSON.stringify(payload)};
    var host = document.createElement("div");
    host.id = "sy-ext-popup-host";
    host.style.cssText = "position:fixed;z-index:2147483647;width:360px;max-height:520px;overflow:auto;"
        + "background:#fff;color:#202124;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.28);"
        + "font-size:13px;";
    // light DOM（不用 shadow）：扩展 popup JS 用 document.getElementById / body.appendChild
    // 找自己的控件，shadow 会隔离它们的查找与挂载
    var style = document.createElement("style");
    style.textContent = P.css + "\\n#sy-ext-popup-close{position:absolute;top:4px;right:8px;cursor:pointer;"
        + "color:#5f6368;font-size:14px;line-height:1;}"
        + "\\n.sy-ext-popup-wrap{position:relative;}";
    host.appendChild(style);
    var wrap = document.createElement("div");
    wrap.className = "sy-ext-popup-wrap";
    host.__syWrap = wrap;
    var closeBtn = document.createElement("span");
    closeBtn.id = "sy-ext-popup-close";
    closeBtn.textContent = "\\u00d7";
    closeBtn.addEventListener("click", function () { close(); });
    wrap.appendChild(closeBtn);
    var content = document.createElement("div");
    content.innerHTML = P.bodyHtml;
    wrap.appendChild(content);
    host.appendChild(wrap);
    // body 未就绪时挂 documentElement 也能显示
    (document.body || document.documentElement).appendChild(host);
    function position() {
        var a = P.anchor;
        var r = host.getBoundingClientRect();
        var right = a ? a.right : 24;
        var bottom = a ? (a.bottom + 6) : 60;
        var left = Math.max(8, Math.min(right - r.width, (window.innerWidth || 800) - r.width - 8));
        var top = Math.max(8, Math.min(bottom, (window.innerHeight || 600) - r.height - 8));
        host.style.left = left + "px";
        host.style.top = top + "px";
    }
    function close() {
        try { host.remove(); } catch (e) {}
        document.removeEventListener("mousedown", onOutside, true);
        document.removeEventListener("keydown", onKey, true);
        delete window.__syExtPopup;
    }
    function onOutside(ev) {
        if (!host.contains(ev.target) && ev.target !== host) close();
    }
    function onKey(ev) { if (ev.key === "Escape") close(); }
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    position();
    window.__syExtPopup = { close: close };
    // 扩展自己的 JS 由宿主按 evalJs 通道执行（扩展专属世界，chrome.* 可用）
    return true;
})()`;
        const r = await webview.executeJavaScript(runner, false);
        if (r !== true) return { ok: false, error: "popup 注入失败" };
        if (useEvalJs) {
            // 所有脚本打包进单个 IIFE：文件间共享顶层声明（lib 的 const 对 popup.js
            // 可见），且每次打开都是全新闭包 —— 世界复用时重开不会再撞
            // "Identifier has already been declared"
            const bundle =
                POPUP_JS_PRELUDE +
                "\n;(function(){\n" +
                jsSources.join("\n;\n") +
                "\n})();";
            try {
                await opts.evalJs(bundle);
            } catch (e: any) {
                return { ok: false, error: "popup 脚本执行失败: " + String(e?.message || e).slice(0, 200) };
            }
        }
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
    }
}

/** 关闭目标页里已打开的 popup（切换标签/导航时调用，避免面板悬挂在错误页面） */
export async function closeExtensionPopupInPage(webview: IWebviewTag): Promise<void> {
    try {
        await webview.executeJavaScript(
            `try { window.__syExtPopup && window.__syExtPopup.close(); } catch (e) {}`,
            false,
        );
    } catch {}
}