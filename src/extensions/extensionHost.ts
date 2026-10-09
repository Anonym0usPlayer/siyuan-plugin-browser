import { Dialog, showMessage } from "siyuan";
import type { IWebviewTag } from "../types";
import { parseExtensionPackage } from "./crx";
import { remoteSession } from "../utils/electron";

/**
 * Chrome 扩展支持（模拟扩展宿主）。
 *
 * Electron 的 session.loadExtension 仅在主进程可用，插件运行在渲染进程无法调用，
 * 因此这里实现一个轻量扩展宿主：
 * - 从本地目录读取未打包扩展（manifest.json + content scripts），或安装 CRX / ZIP 扩展包
 *   （CRX 头解析后解压到插件存储目录再按目录安装）
 * - 原生模式优先：通过 @electron/remote 调用主进程 session.loadExtension 装入
 *   webview 专用 partition（persist:siyuan-browser），由 Chromium 运行真正的扩展
 *   （内容脚本隔离世界、chrome-extension:// 资源、background 视 Electron 支持程度）。
 *   原生不可用/加载失败的扩展回退到下述垫片模式
 * - 垫片模式：在 webview 每次页面加载完成（dom-ready）后按 match pattern 注入内容脚本与样式
 * - 提供常用 chrome.* API 垫片：storage（localStorage 持久化）/ i18n / runtime.getURL
 *
 * 已知限制（v1）：
 * - 不执行 background / service_worker / popup 页面
 * - 内容脚本运行在页面主世界（isolated world 不可用）
 * - chrome.runtime.sendMessage 无接收方（background 未执行）
 */

export interface IInstalledExtension {
    /** 稳定 id（路径哈希） */
    id: string;
    name: string;
    version: string;
    description: string;
    /** 扩展目录绝对路径 */
    path: string;
    enabled: boolean;
    manifestVersion: number;
    /** manifest 声明了 background（当前版本不执行，仅提示） */
    hasBackground: boolean;
    /** 默认 locale（i18n 垫片用） */
    defaultLocale: string;
    /** content_scripts 配置（安装时快照） */
    contentScripts: Array<{ matches: string[]; js: string[]; css: string[] }>;
    /** 原生模式：已通过 session.loadExtension 装入 webview partition（Chromium 注入内容脚本，垫片不再介入） */
    native?: boolean;
    /** 原生模式下 Electron 侧的扩展 id（removeExtension 用） */
    electronId?: string;
    /** 原生加载失败原因（为空且 native=false 时表示垫片模式正常） */
    nativeError?: string;
}

const EXTENSIONS_KEY = "extensions.json";

/** 简易字符串哈希（扩展 id 生成用） */
function strHash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

function nodeModules() {
    const req = (window as any).require;
    return {
        fs: req("fs") as typeof import("fs"),
        path: req("path") as typeof import("path"),
        os: req("os") as typeof import("os"),
        ipcRenderer: req("electron")?.ipcRenderer,
    };
}

// === Chrome match pattern（https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns）===

export function matchesUrlPattern(pattern: string, rawUrl: string): boolean {
    if (pattern === "<all_urls>") {
        return /^https?:\/\//i.test(rawUrl);
    }
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
    // patterns 允许带端口，优先按 host（含端口）比较
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
    // path：把 pattern 转成正则（* → .*）
    const path = url.pathname + url.search;
    const regex = new RegExp(
        "^" + pathPat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
    );
    return regex.test(path);
}

export class ExtensionHost {
    private plugin: any;
    private extensions: IInstalledExtension[] = [];
    private loaded = false;
    /** 扩展文件内容缓存（key: path:file） */
    private fileCache: Map<string, string> = new Map();

    constructor(plugin: any) {
        this.plugin = plugin;
    }

    private readFileCached(extPath: string, rel: string): string {
        const key = extPath + ":" + rel;
        let content = this.fileCache.get(key);
        if (content == null) {
            const { fs, path } = nodeModules();
            content = fs.readFileSync(path.join(extPath, rel), "utf8");
            this.fileCache.set(key, content);
        }
        return content;
    }

    async load(): Promise<void> {
        try {
            const data = await this.plugin.loadData(EXTENSIONS_KEY);
            this.extensions = data ? (typeof data === "string" ? JSON.parse(data) : data) : [];
        } catch {
            this.extensions = [];
        }
        // Electron 的 session 扩展不跨重启持久化，启动时全部恢复（原生优先，失败回退垫片）
        await this.reconcileNative();
        this.loaded = true;
    }

    /**
     * 尝试用 Electron 原生扩展运行时（session.loadExtension）加载扩展。
     * 可用且加载成功 → native=true（内容脚本由 Chromium 注入隔离世界，垫片不介入）；
     * 不可用或失败 → native=false + nativeError，走垫片注入。
     */
    private async reconcileNative(): Promise<void> {
        const ses = remoteSession();
        if (!ses) {
            for (const ext of this.extensions) {
                ext.native = false;
                ext.nativeError = undefined;
            }
            return;
        }
        let changed = false;
        for (const ext of this.extensions) {
            if (!ext.enabled) {
                if (ext.native) {
                    try {
                        ext.electronId && ses.removeExtension(ext.electronId);
                    } catch {}
                    ext.native = false;
                    changed = true;
                }
                continue;
            }
            try {
                // 同路径已加载（如重启后 session 仍保留）→ 直接同步 id，不重复加载
                const normPath = ext.path.replace(/\\/g, "/");
                const existing = (ses.getAllExtensions?.() || []).find(
                    (x: any) => x.path && x.path.replace(/\\/g, "/") === normPath
                );
                let info = existing;
                if (!info) {
                    info = await ses.loadExtension(ext.path, { allowFileAccess: true });
                }
                if (ext.native !== true || ext.electronId !== info.id) changed = true;
                ext.native = true;
                ext.electronId = info.id;
                ext.nativeError = undefined;
            } catch (e: any) {
                if (ext.native !== false) changed = true;
                ext.native = false;
                ext.nativeError = String(e?.message || e);
            }
        }
        if (changed) await this.persist();
    }

    private async persist(): Promise<void> {
        await this.plugin.saveData(EXTENSIONS_KEY, JSON.stringify(this.extensions));
    }

    list(): IInstalledExtension[] {
        return [...this.extensions];
    }

    /** 解析 manifest 字段里的 __MSG_xxx__ 占位符（_locales 消息），失败时原样返回 */
    private resolveManifestString(value: string, extPath: string, defaultLocale: string): string {
        const m = String(value || "").match(/^__MSG_(.+?)__$/);
        if (!m) return value;
        const locales = [defaultLocale, "en", "zh_CN"].filter(Boolean);
        for (const locale of locales) {
            try {
                const messages = JSON.parse(this.readFileCached(extPath, `_locales/${locale}/messages.json`));
                const msg = messages?.[m[1]]?.message;
                if (msg) return msg;
            } catch {}
        }
        return value;
    }

    /** 展开 ~ 与环境变量后读取目录下的 manifest.json */
    async installFromPath(rawDir: string): Promise<{ ok: boolean; error?: string; ext?: IInstalledExtension }> {
        const { fs, path, os } = nodeModules();
        let dir = this.expandPath(rawDir);
        try {
            const manifestPath = path.join(dir, "manifest.json");
            if (!fs.existsSync(manifestPath)) {
                return { ok: false, error: "manifest.json not found: " + dir };
            }
            const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            if (!manifest || (!manifest.content_scripts && !manifest.name)) {
                return { ok: false, error: "invalid manifest.json" };
            }
            const normDir = dir.replace(/\\/g, "/");
            const displayName = this.resolveManifestString(manifest.name || path.basename(dir), normDir, manifest.default_locale || "");
            const displayDesc = this.resolveManifestString(manifest.description || "", normDir, manifest.default_locale || "");
            const contentScripts: IInstalledExtension["contentScripts"] = (manifest.content_scripts || []).map(
                (cs: any) => ({
                    matches: cs.matches || [],
                    js: cs.js || [],
                    css: cs.css || [],
                })
            );
            const ext: IInstalledExtension = {
                id: strHash(dir) + "-" + (manifest.version || "0"),
                name: displayName,
                version: manifest.version || "",
                description: displayDesc,
                path: normDir,
                enabled: true,
                manifestVersion: manifest.manifest_version || 2,
                hasBackground: !!(manifest.background || manifest.service_worker),
                defaultLocale: manifest.default_locale || "",
                contentScripts,
            };
            // 同目录重复安装 → 更新
            const idx = this.extensions.findIndex((e) => e.path === ext.path);
            if (idx >= 0) {
                this.extensions[idx] = ext;
            } else {
                this.extensions.push(ext);
            }
            // 原生运行时优先：loadExtension 成功则由 Chromium 接管内容脚本
            ext.native = false;
            ext.nativeError = undefined;
            try {
                const ses = remoteSession();
                if (ses) {
                    const existing = (ses.getAllExtensions?.() || []).find((x: any) => x.path === ext.path);
                    const info = existing || (await ses.loadExtension(ext.path, { allowFileAccess: true }));
                    ext.native = true;
                    ext.electronId = info.id;
                    ext.nativeError = undefined;
                }
            } catch (e: any) {
                ext.nativeError = String(e?.message || e);
            }
            await this.persist();
            return { ok: true, ext };
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e) };
        }
    }

    private expandPath(raw: string): string {
        const { path, os } = nodeModules();
        let p = String(raw || "").trim().replace(/^"(.*)"$/, "$1");
        if (p.startsWith("~")) {
            p = path.join(os.homedir(), p.slice(1));
        }
        return p;
    }

    /**
     * 安装 CRX / ZIP 扩展包：解析 CRX 头取出 ZIP，解压到插件存储目录
     * （{workspace}/data/storage/petal/{plugin}/extensions/）后按目录安装。
     * 同一源文件重复安装 → 解压到同一目录 → 视为更新。
     */
    async installFromPackage(rawFile: string): Promise<{ ok: boolean; error?: string; ext?: IInstalledExtension }> {
        const { fs, path } = nodeModules();
        const file = this.expandPath(rawFile);
        try {
            if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
                return { ok: false, error: "file not found: " + file };
            }
            const parsed = parseExtensionPackage(fs.readFileSync(file));
            if (!parsed.ok || !parsed.zip) {
                return { ok: false, error: parsed.error };
            }
            // 懒加载：避免 adm-zip（及其对 node 内置模块的 require）在插件加载期执行
            const AdmZip: typeof import("adm-zip") = require("adm-zip");
            const zip = new AdmZip(parsed.zip);
            const baseName =
                path.basename(file).replace(/\.(crx|zip)$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim() || "extension";
            const workspaceDir = (window as any).siyuan?.config?.system?.workspaceDir;
            if (!workspaceDir) {
                return { ok: false, error: "workspaceDir unavailable" };
            }
            const extensionsRoot = path.join(
                workspaceDir,
                "data",
                "storage",
                "petal",
                this.plugin?.name || "siyuan-plugin-browser",
                "extensions"
            );
            const targetDir = path.join(extensionsRoot, `${baseName}-${strHash(file)}`);
            fs.rmSync(targetDir, { recursive: true, force: true });
            fs.mkdirSync(targetDir, { recursive: true });
            zip.extractAllTo(targetDir, true);
            // 包根目录没有 manifest.json 时，若所有条目都在唯一一层目录下则下钻一层
            let installDir = targetDir;
            if (!fs.existsSync(path.join(installDir, "manifest.json"))) {
                const tops = [...new Set(
                    zip.getEntries()
                        .map((e) => (e.entryName || "").split("/")[0])
                        .filter(Boolean)
                )];
                if (tops.length === 1 && fs.existsSync(path.join(targetDir, tops[0], "manifest.json"))) {
                    installDir = path.join(targetDir, tops[0]);
                } else {
                    return { ok: false, error: "manifest.json not found in package: " + path.basename(file) };
                }
            }
            return await this.installFromPath(installDir);
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e) };
        }
    }

    /** 输入路径智能安装：CRX/ZIP 文件按包安装，目录按未打包扩展安装 */
    async installFromInput(rawPath: string): Promise<{ ok: boolean; error?: string; ext?: IInstalledExtension }> {
        const { fs } = nodeModules();
        const p = this.expandPath(rawPath);
        try {
            if (fs.existsSync(p) && fs.statSync(p).isFile()) {
                return await this.installFromPackage(p);
            }
        } catch {}
        return await this.installFromPath(p);
    }

    async uninstall(id: string): Promise<void> {
        const ext = this.extensions.find((e) => e.id === id);
        if (ext?.electronId) {
            try {
                remoteSession()?.removeExtension(ext.electronId);
            } catch {}
        }
        this.extensions = this.extensions.filter((e) => e.id !== id);
        await this.persist();
    }

    async setEnabled(id: string, enabled: boolean): Promise<void> {
        const ext = this.extensions.find((e) => e.id === id);
        if (!ext) return;
        ext.enabled = enabled;
        // 原生优先：启用时重新 loadExtension，停用时从 session 移除
        const ses = remoteSession();
        try {
            if (enabled) {
                if (ses) {
                    const info = await ses.loadExtension(ext.path, { allowFileAccess: true });
                    ext.native = true;
                    ext.electronId = info.id;
                    ext.nativeError = undefined;
                }
            } else if (ext.native && ext.electronId) {
                ses?.removeExtension(ext.electronId);
                ext.native = false;
                ext.nativeError = undefined;
            }
        } catch (e: any) {
            ext.native = false;
            ext.nativeError = String(e?.message || e);
        }
        await this.persist();
    }

    /**
     * 向 webview 注入所有匹配的扩展内容脚本（dom-ready 时由 WebviewController 调用）。
     * 同步触发、内部异步执行，不阻塞页面。
     */
    inject(webview: IWebviewTag, url: string): void {
        if (!this.loaded) return;
        for (const ext of this.extensions) {
            if (!ext.enabled) continue;
            if (ext.native) continue; // 原生扩展由 Chromium 自行注入（含隔离世界），垫片跳过
            const matched = ext.contentScripts.filter((cs) =>
                (cs.matches || []).some((p) => matchesUrlPattern(p, url))
            );
            if (matched.length === 0) continue;
            this.injectExtension(webview, ext, matched).catch((e) => {
                console.warn(`[browser-plugin] inject extension "${ext.name}" failed:`, e);
            });
        }
    }

    private async injectExtension(
        webview: IWebviewTag,
        ext: IInstalledExtension,
        matched: IInstalledExtension["contentScripts"]
    ): Promise<void> {
        // 1. CSS
        for (const cs of matched) {
            for (const cssFile of cs.css || []) {
                try {
                    const css = this.readFileCached(ext.path, cssFile);
                    await (webview as any).insertCSS(css);
                } catch (e) {
                    console.warn(`[browser-plugin] ext css ${cssFile} failed:`, e);
                }
            }
        }
        // 2. chrome.* 垫片 + JS（按顺序执行）
        const shim = this.buildChromeShim(ext);
        await webview.executeJavaScript(shim);
        for (const cs of matched) {
            for (const jsFile of cs.js || []) {
                try {
                    const code = this.readFileCached(ext.path, jsFile);
                    await webview.executeJavaScript(code);
                } catch (e) {
                    console.warn(`[browser-plugin] ext js ${jsFile} failed:`, e);
                }
            }
        }
    }

    /** 构建单个扩展的 chrome.* API 垫片脚本 */
    private buildChromeShim(ext: IInstalledExtension): string {
        // 读取 i18n 消息（default_locale 或 en），读取失败留空
        let messages: Record<string, any> = {};
        try {
            const locales = [ext.defaultLocale, "en", "zh_CN"].filter(Boolean);
            for (const locale of locales) {
                try {
                    messages = JSON.parse(this.readFileCached(ext.path, `_locales/${locale}/messages.json`));
                    break;
                } catch {}
            }
        } catch {}
        const manifestJson = JSON.stringify({
            manifest_version: ext.manifestVersion,
            name: ext.name,
            version: ext.version,
            description: ext.description,
            default_locale: ext.defaultLocale,
        });
        const messagesJson = JSON.stringify(messages);
        return `
(function() {
    var EXT = ${JSON.stringify({ id: ext.id, name: ext.name, path: ext.path })};
    window.chrome = window.chrome || {};
    var chrome_ = window.chrome;
    chrome_.__syBrowserExtensions = chrome_.__syBrowserExtensions || {};
    if (chrome_.__syBrowserExtensions[EXT.id]) return;
    chrome_.__syBrowserExtensions[EXT.id] = true;

    // runtime
    var messageListeners = [];
    chrome_.runtime = {
        id: EXT.id,
        getManifest: function() { return ${manifestJson}; },
        getURL: function(p) { return "chrome-extension://" + EXT.id + "/" + String(p || "").replace(/^\\//, ""); },
        onMessage: {
            addListener: function(fn) { messageListeners.push(fn); },
            removeListener: function(fn) { messageListeners = messageListeners.filter(function(f) { return f !== fn; }); },
        },
        sendMessage: function(msg, cb) {
            // background 未执行：无接收方
            if (typeof cb === "function") { try { cb(undefined); } catch (e) {} }
            return Promise.resolve(undefined);
        },
        connect: function() {
            return { onMessage: { addListener: function() {} }, postMessage: function() {}, disconnect: function() {} };
        },
    };

    // i18n
    var MESSAGES = ${messagesJson};
    chrome_.i18n = chrome_.i18n || {};
    chrome_.i18n.getMessage = function(key, args) {
        var entry = MESSAGES[key];
        var msg = entry ? (entry.message || "") : "";
        if (msg && args != null) {
            var arr = Array.isArray(args) ? args : [args];
            msg = msg.replace(/\\$(\\d+)/g, function(m, i) { return arr[Number(i) - 1] != null ? arr[Number(i) - 1] : m; });
        }
        return msg;
    };
    chrome_.i18n.getUILanguage = function() { return navigator.language; };

    // storage：local/sync 用 localStorage 持久化（随 partition 保留）
    function storageArea(ns) {
        var key = "__syExtStorage_" + ns + "_" + EXT.id;
        function read() {
            try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch (e) { return {}; }
        }
        function write(data) {
            try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) {}
        }
        function normalizeKeys(keys, data) {
            var out = {};
            if (keys == null) { out = data; }
            else if (typeof keys === "string") { out[keys] = data[keys]; }
            else if (Array.isArray(keys)) { keys.forEach(function(k) { out[k] = data[k]; }); }
            else { for (var k in keys) { out[k] = (k in data) ? data[k] : keys[k]; } }
            return out;
        }
        return {
            get: function(keys, cb) {
                var out = normalizeKeys(keys, read());
                if (typeof cb === "function") { try { cb(out); } catch (e) {} }
                return Promise.resolve(out);
            },
            set: function(items, cb) {
                var data = read();
                for (var k in items) { data[k] = items[k]; }
                write(data);
                if (typeof cb === "function") { try { cb(); } catch (e) {} }
                return Promise.resolve();
            },
            remove: function(keys, cb) {
                var data = read();
                (Array.isArray(keys) ? keys : [keys]).forEach(function(k) { delete data[k]; });
                write(data);
                if (typeof cb === "function") { try { cb(); } catch (e) {} }
                return Promise.resolve();
            },
            clear: function(cb) {
                write({});
                if (typeof cb === "function") { try { cb(); } catch (e) {} }
                return Promise.resolve();
            },
        };
    }
    chrome_.storage = chrome_.storage || {};
    if (!chrome_.storage.local) chrome_.storage.local = storageArea("local");
    if (!chrome_.storage.sync) chrome_.storage.sync = storageArea("sync");
    chrome_.storage.session = chrome_.storage.session || storageArea("session");
})();
`;
    }

    /** 通过系统对话框选择扩展目录（远程内核模式降级为输入路径） */
    async pickExtensionDirectory(title: string): Promise<string | null> {
        const { ipcRenderer } = nodeModules();
        if (ipcRenderer?.invoke) {
            try {
                const result = await ipcRenderer.invoke("siyuan-get", {
                    cmd: "showOpenDialog",
                    title,
                    properties: ["openDirectory"],
                });
                if (result && !result.canceled && result.filePaths?.length) {
                    return result.filePaths[0];
                }
                if (result && !result.canceled) return null;
                // remote 模式下被拒（canceled=true 但无路径），走输入框兜底
            } catch (e) {
                console.warn("[browser-plugin] showOpenDialog failed:", e);
            }
        }
        return null;
    }

    /** 通过系统对话框选择扩展包文件（CRX / ZIP），远程内核模式返回 null 降级为输入路径 */
    async pickExtensionFile(title: string): Promise<string | null> {
        const { ipcRenderer } = nodeModules();
        if (ipcRenderer?.invoke) {
            try {
                const result = await ipcRenderer.invoke("siyuan-get", {
                    cmd: "showOpenDialog",
                    title,
                    properties: ["openFile"],
                    filters: [{ name: "Chrome Extension", extensions: ["crx", "zip"] }],
                });
                if (result && !result.canceled && result.filePaths?.length) {
                    return result.filePaths[0];
                }
                if (result && !result.canceled) return null;
            } catch (e) {
                console.warn("[browser-plugin] showOpenDialog failed:", e);
            }
        }
        return null;
    }

    /** 扩展管理对话框 */
    openManager(i18n: Record<string, string>): void {
        const dialog = new Dialog({
            title: i18n.extManager || "Chrome 扩展",
            content: `<div class="sy-ext-manager" style="padding:16px;"></div>`,
            width: "620px",
        });
        const container = dialog.element.querySelector(".sy-ext-manager") as HTMLElement;
        const render = () => {
            container.innerHTML = "";
            const hint = document.createElement("div");
            hint.style.cssText = "font-size:12px;color:var(--b3-theme-on-surface-light);margin-bottom:8px;line-height:1.6;";
            hint.textContent = i18n.extHint || "支持安装未打包的 Chrome 扩展目录（manifest.json）或 CRX / ZIP 扩展包。内容脚本将注入到所有浏览器页签；扩展的 background/popup 不执行，部分扩展可能无法完整工作。安装后刷新页签生效。";
            container.appendChild(hint);

            const toolbar = document.createElement("div");
            toolbar.style.cssText = "display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;";
            const pickBtn = document.createElement("button");
            pickBtn.className = "b3-button";
            pickBtn.textContent = i18n.extPickFolder || "选择扩展目录安装...";
            pickBtn.addEventListener("click", async () => {
                const dir = await this.pickExtensionDirectory(i18n.extManager || "Chrome 扩展");
                if (!dir) return;
                const r = await this.installFromInput(dir);
                if (r.ok) {
                    showMessage((i18n.extInstalled || "已安装扩展") + ": " + r.ext!.name, 3000, "info");
                    render();
                } else {
                    showMessage((i18n.extInstallFailed || "安装扩展失败") + ": " + r.error, 5000, "error");
                }
            });
            toolbar.appendChild(pickBtn);

            const pickFileBtn = document.createElement("button");
            pickFileBtn.className = "b3-button";
            pickFileBtn.textContent = i18n.extPickCrx || "安装 CRX / ZIP 包...";
            pickFileBtn.addEventListener("click", async () => {
                const file = await this.pickExtensionFile(i18n.extManager || "Chrome 扩展");
                if (!file) return;
                const r = await this.installFromPackage(file);
                if (r.ok) {
                    showMessage((i18n.extInstalled || "已安装扩展") + ": " + r.ext!.name, 3000, "info");
                    render();
                } else {
                    showMessage((i18n.extInstallFailed || "安装扩展失败") + ": " + r.error, 5000, "error");
                }
            });
            toolbar.appendChild(pickFileBtn);

            // 手动输入路径安装（远程内核/对话框不可用时）：目录按目录装，CRX/ZIP 文件解压安装
            const input = document.createElement("input");
            input.className = "b3-text-field";
            input.style.flex = "1";
            input.style.minWidth = "200px";
            input.placeholder = "C:\\path\\to\\extension.crx 或 /path/to/extension 目录";
            toolbar.appendChild(input);
            const manualBtn = document.createElement("button");
            manualBtn.className = "b3-button";
            manualBtn.textContent = i18n.extInstallPath || "按路径安装";
            manualBtn.addEventListener("click", async () => {
                const p = input.value.trim();
                if (!p) return;
                const r = await this.installFromInput(p);
                if (r.ok) {
                    showMessage((i18n.extInstalled || "已安装扩展") + ": " + r.ext!.name, 3000, "info");
                    render();
                } else {
                    showMessage((i18n.extInstallFailed || "安装扩展失败") + ": " + r.error, 5000, "error");
                }
            });
            toolbar.appendChild(manualBtn);
            container.appendChild(toolbar);

            const list = this.list();
            if (list.length === 0) {
                const empty = document.createElement("div");
                empty.style.cssText = "text-align:center;padding:24px;color:var(--b3-theme-on-surface-light);";
                empty.textContent = i18n.extEmpty || "尚未安装扩展";
                container.appendChild(empty);
            }
            for (const ext of list) {
                const row = document.createElement("div");
                row.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--b3-border-color);";
                const cb = document.createElement("input");
                cb.type = "checkbox";
                cb.className = "b3-switch";
                cb.checked = ext.enabled;
                cb.title = i18n.extEnabled || "启用";
                cb.addEventListener("change", async () => {
                    await this.setEnabled(ext.id, cb.checked);
                });
                row.appendChild(cb);
                const info = document.createElement("div");
                info.style.cssText = "flex:1;min-width:0;";
                info.innerHTML =
                    `<div style="font-weight:500;">${escapeHtml(ext.name)} <span style="color:var(--b3-theme-on-surface-light);font-size:12px;">v${escapeHtml(ext.version)} · MV${ext.manifestVersion}</span>` +
                    (ext.native
                        ? ` <span title="${escapeHtml(i18n.extNativeTip || "Electron 原生扩展运行时")}（${escapeHtml(ext.electronId || "")}）" style="color:var(--b3-theme-primary,#3575f0);font-size:12px;">● ${escapeHtml(i18n.extNative || "原生")}</span>`
                        : ` <span title="${escapeHtml(ext.nativeError || i18n.extShimTip || "chrome.* 垫片模拟")}（${escapeHtml(i18n.extShim || "垫片")}）" style="color:var(--b3-theme-on-surface-light);font-size:12px;">○ ${escapeHtml(i18n.extShim || "垫片")}</span>`) +
                    (ext.hasBackground && !ext.native
                        ? ` <span title="${escapeHtml(i18n.extBackgroundWarn || "依赖 background，本宿主不执行，可能无效")}" style="color:var(--b3-theme-warning,#d97706);font-size:12px;">⚠ background</span>`
                        : "") +
                    `</div>` +
                    `<div style="font-size:12px;color:var(--b3-theme-on-surface-light);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(ext.path)}">${escapeHtml(ext.path)}</div>` +
                    (ext.nativeError
                        ? `<div style="font-size:12px;color:var(--b3-theme-error,#d23f31);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(ext.nativeError)}">${escapeHtml(ext.nativeError)}</div>`
                        : "");
                row.appendChild(info);
                const delBtn = document.createElement("button");
                delBtn.className = "b3-button b3-button--cancel";
                delBtn.textContent = i18n.delete || "删除";
                delBtn.addEventListener("click", async () => {
                    await this.uninstall(ext.id);
                    render();
                });
                row.appendChild(delBtn);
                container.appendChild(row);
            }
        };
        render();
    }
}

function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
