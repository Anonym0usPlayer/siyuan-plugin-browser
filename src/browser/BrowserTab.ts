import { Menu, showMessage } from "siyuan";
import type { BrowserSettings, IWebviewTag } from "../types";
import { Toolbar } from "./Toolbar";
import { WebviewController } from "./WebviewController";
import { el } from "../utils/dom";
import { normalizeUrl } from "../utils/url";
import type { HistoryStore } from "../storage/historyStore";
import type { BookmarksStore } from "../storage/bookmarksStore";
import type { SettingsStore } from "../storage/settingsStore";
import { SettingsDialog } from "../settings/SettingsDialog";
import { clipToSiYuan } from "./excerpt";
import { EDGE_UA } from "../extensions/edgeStore";
import { isEdgeAddonsSiteUrl } from "../extensions/edgeStoreHelper";
import { BROWSER_PARTITION } from "../constants";
import { remoteSession } from "../utils/electron";

/** 浏览器页签实例依赖 */
export interface BrowserTabDeps {
    i18n: Record<string, string>;
    settings: SettingsStore;
    history: HistoryStore;
    bookmarks: BookmarksStore;
    openUrlInNewTab: (url: string) => void;
    /** 触发下载（由 index.ts 注入，调用内核 RPC） */
    startDownload: (url: string, suggestedName?: string) => Promise<void>;
    /** 通知页签标题更新（思源 tab 头部） */
    onTabTitleChange: (title: string) => void;
    /** 通知页签图标更新 */
    onTabIconChange: (icon: string) => void;
    /** Chrome 扩展内容脚本注入（每次 webview 页面 dom-ready 时调用） */
    injectExtensions?: (webview: IWebviewTag, url: string) => void;
    /** Edge 加载项商店安装（详情页悬浮按钮 / 协议跳转拦截触发） */
    installEdgeExtension?: (id: string, source: string) => Promise<{ ok: boolean; error?: string; ext?: any } | void>;
}

/**
 * 浏览器页签模型：每个浏览器页签实例对应一个 BrowserTab。
 * 由 SiYuan 自定义页签的 init() 创建，destroy() 销毁。
 */
export class BrowserTab {
    readonly element: HTMLElement;
    private toolbar: Toolbar;
    private webview: IWebviewTag;
    private controller: WebviewController;
    private deps: BrowserTabDeps;
    private settings: BrowserSettings;
    private disposed = false;
    /** webview 重建中标记（防止重复重建） */
    private rebuilding = false;
    /** webview 健康监测定时器 */
    private healthTimer: any = null;
    /** 连续健康检查失败计数（连续 2 次才判定损坏） */
    private healthFailCount = 0;
    /** Electron 默认 UA（懒捕获：构造时 webview 可能尚未 attach） */
    private defaultUserAgent = "";
    /** 当前是否处于商店伪装 UA 态（离开商店时恢复默认） */
    private edgeUaActive = false;

    constructor(deps: BrowserTabDeps, initialUrl?: string) {
        this.deps = deps;
        this.settings = deps.settings.get();
        this.element = this.buildDom();
        this.webview = this.element.querySelector("webview") as unknown as IWebviewTag;
        this.toolbar = new Toolbar(deps.i18n, {
            onAction: (action, payload) => this.onToolbarAction(action, payload),
            onUrlSubmit: (url) => this.controller.loadURL(url),
            onFindInPage: (text) => this.controller.findInPage(text),
        }, this.settings);
        this.controller = new WebviewController(this.webview, {
            settings: this.settings,
            history: deps.history,
            bookmarks: deps.bookmarks,
            i18n: deps.i18n,
            callbacks: {
                onUrlChange: (url) => {
                    this.toolbar.setUrl(url);
                    this.updateBookmarkButton(url);
                    this.syncUserAgent(url);
                },
                onTitleChange: (title) => {
                    deps.onTabTitleChange(title);
                },
                onLoadingChange: (loading) => {
                    this.toolbar.setLoading(loading);
                    if (!loading) {
                        this.toolbar.setNavState(this.controller.canGoBack(), this.controller.canGoForward());
                        const url = this.controller.getCurrentUrl();
                        if (url) this.updateBookmarkButton(url);
                    }
                },
                onFaviconChange: (favicon) => {
                    // 思源页签图标更新可通过 onTabIconChange 通知
                    deps.onTabIconChange(favicon);
                },
                onOpenNewTab: (url) => deps.openUrlInNewTab(url),
                onSaveAs: (url, name) => {
                    deps.startDownload(url, name);
                },
                onToggleBookmark: () => this.toggleBookmark(),
                onInspect: () => {
                    try {
                        this.webview.openDevTools?.();
                    } catch {}
                },
                onFindResult: (active, total) => {
                    this.toolbar.setFindResult(active, total);
                },
                onExcerpt: (mode: "article" | "part") => {
                    const s = this.settings;
                    clipToSiYuan(this.webview, {
                        mode: mode || "article",
                        notebookId: s.excerptNotebook || "",
                        parentPath: s.excerptParentPath || "/",
                        tags: s.excerptTags || "",
                        assets: s.excerptAssets !== false,
                        exp: {
                            bold: !!s.excerptExpBold,
                            italic: !!s.excerptExpItalic,
                            underline: !!s.excerptExpUnderline,
                            removeImgLink: !!s.excerptExpRemoveImgLink,
                            span: !!s.excerptExpSpan,
                            svgToImg: !!s.excerptExpSvgToImg,
                        },
                    }, this.deps.i18n);
                },
                onEdgeInstall: (id: string, source: string) =>
                    this.deps.installEdgeExtension?.(id, source) ?? Promise.resolve(),
            },
        });

        // 把工具栏插到 webview 之前
        this.element.insertBefore(this.toolbar.element, this.webview.parentElement);

        // 监听设置变化
        deps.settings.onChange(() => {
            this.settings = deps.settings.get();
            this.toolbar.updateSettings(this.settings);
            this.controller.updateSettings(this.settings);
        });

        // 监听书签变化（更新收藏按钮）
        deps.bookmarks.onChange(() => {
            this.updateBookmarkButton(this.controller.getCurrentUrl());
        });

        // 应用 user-agent
        if (this.settings.userAgent) {
            this.webview.useragent = this.settings.userAgent;
        }

        // 注册 webRequest 拦截器（CSP 移除 + Referer 注入）
        // 通过 partition + session.fromPartition() 获取 session，不依赖 did-attach
        // 必须在 webview 加载内容前注册，否则首批请求会漏掉
        this.stripSiteSecurityHeaders();

        this.controller.attach();

        // Chrome 扩展内容脚本注入（每次页面导航完成后由 dom-ready 触发）
        if (deps.injectExtensions) {
            this.controller.onDomReady = (wv, url) => deps.injectExtensions!(wv, url);
        }

        // 启动 webview 健康监测：思源分屏/拖动页签会搬移 panelElement，
        // Electron webview 被重新挂载后 guest 即损坏（白屏且无响应），需自动重建
        this.startHealthMonitor();

        // 异步初始化：先确保 preload 路径就绪，再加载初始 URL
        // preload 必须在 webview 第一次加载前设置，否则不生效
        this.init(initialUrl);
    }

    /** 在当前浏览器标签页中加载新 URL（替换当前页，浏览器行为） */
    loadURL(url: string): void {
        this.controller.loadURL(url);
    }

    /**
     * 通过 session 的 webRequest API 移除响应头中的 CSP / X-Frame-Options，
     * 并为所有出站请求注入 Referer，避免 CDN 防盗链 403。
     * 使用 partition="persist:siyuan-browser" + session.fromPartition() 直接获取 session，
     * 不依赖 did-attach 事件，确保在 webview 内容加载前就注册好拦截器。
     */
    private stripSiteSecurityHeaders(): void {
        try {
            // 首选：@electron/remote 获取主进程 session（最可靠）；
            // 降级：webview.getWebContents()（Electron 新版本可能移除）
            const session = remoteSession(BROWSER_PARTITION) || this.webviewSessionFallback();
            if (!session?.webRequest) {
                console.warn("[browser-plugin] no session available for webRequest");
                return;
            }
            this.registerWebRequest(session);
        } catch (e) {
            console.warn("[browser-plugin] stripSiteSecurityHeaders failed:", e);
        }
    }

    private webviewSessionFallback(): any | null {
        try {
            const wv: any = this.webview;
            return wv?.getWebContents?.()?.session || null;
        } catch {
            return null;
        }
    }

    private registerWebRequest(session: any): void {
        // 1. 响应头：移除站点安全限制（CSP / X-Frame-Options）
        session.webRequest.onHeadersReceived((details: any, cb: (r: any) => void) => {
            const headers: Record<string, string> = {};
            if (details?.responseHeaders) {
                for (const key of Object.keys(details.responseHeaders)) {
                    headers[key.toLowerCase()] = details.responseHeaders[key];
                }
            }
            delete headers["content-security-policy"];
            delete headers["content-security-policy-report-only"];
            delete headers["x-frame-options"];
            const out: Record<string, string[]> = {};
            for (const k in headers) out[k] = [headers[k]];
            cb({ responseHeaders: out });
        });
        // 2. 请求头：为出站请求注入 Referer，绕过 CDN 防盗链
        //    站点 CDN 检测到空 Referer 会返回 403（X-Error-Info: EmptyReferer）
        session.webRequest.onBeforeSendHeaders((details: any, cb: (r: any) => void) => {
            const reqUrl = details.url || "";
            if (!/^https?:\/\//i.test(reqUrl)) {
                cb({ requestHeaders: details.requestHeaders });
                return;
            }
            try {
                const referrer = details.referrer || "";
                // 已有合法 http(s) referer → 不改
                if (referrer && /^https?:\/\//i.test(referrer)) {
                    cb({ requestHeaders: details.requestHeaders });
                    return;
                }
                // 用当前 webview URL 作为 Referer
                const current = this.webview.getURL?.() || "";
                let refUrl = "";
                if (current && /^https?:\/\//i.test(current)) {
                    refUrl = current;
                }
                if (!refUrl) {
                    const target = new URL(reqUrl);
                    refUrl = target.origin + "/";
                }
                const headers = { ...details.requestHeaders };
                headers["Referer"] = refUrl;
                cb({ requestHeaders: headers });
            } catch {
                cb({ requestHeaders: details.requestHeaders });
            }
        });
        console.log("[browser-plugin] webRequest registered (CSP strip + referer inject)");
    }

    private async init(initialUrl?: string): Promise<void> {
        console.log("[browser-plugin] BrowserTab.init, initialUrl:", initialUrl);
        const start = initialUrl || this.settings.homepage;
        if (start && start !== "about:blank") {
            // 先切好 UA 再发首次请求（商店域名需伪装 Edge，否则页内禁用「获取」按钮）
            this.syncUserAgent(start);
            // 先加载 URL（不等 preload，preload 只影响后续页内链接拦截）
            console.log("[browser-plugin] loading URL:", start);
            this.controller.loadURL(start);
        } else {
            console.log("[browser-plugin] skipping load (start is empty or about:blank)");
        }
        // 异步设置 preload（不阻塞首次加载；对后续导航生效）
        this.applyPreload();
    }

    /**
     * 按目标 URL 切换 webview UA。
     * Edge 加载项商店会对 UA 嗅探：非 Edge 浏览器直接禁用「获取」按钮并提示
     * "与你的浏览器不兼容"，因此在商店域名下伪装 Edge UA，离开后恢复
     * （自定义 UA 优先，否则用 Electron 默认）。webview 的 useragent 属性
     * 映射 contents.setUserAgent，对后续导航的 HTTP 头与页内 navigator.userAgent 同时生效。
     */
    private syncUserAgent(url: string): void {
        try {
            const isStore = isEdgeAddonsSiteUrl(url);
            if (!isStore && !this.edgeUaActive) return;
            if (!this.defaultUserAgent) {
                this.defaultUserAgent =
                    (this.webview as any).getUserAgent?.() ||
                    (window as any).navigator?.userAgent ||
                    "";
            }
            const ua = isStore ? EDGE_UA : this.settings.userAgent || this.defaultUserAgent;
            this.edgeUaActive = isStore;
            if (ua && this.webview.useragent !== ua) {
                this.webview.setAttribute("useragent", ua);
                try {
                    (this.webview as any).useragent = ua;
                } catch {}
                console.log("[browser-plugin] webview UA ->", isStore ? "Edge (store)" : "default/custom");
            }
        } catch (e) {
            console.warn("[browser-plugin] syncUserAgent failed:", e);
        }
    }

    /** 从插件主实例获取 preload 路径并应用到 webview */
    private async applyPreload(): Promise<void> {
        if (!this.settings.enablePreload) {
            console.warn("[browser-plugin] preload disabled by setting (enablePreload=false)");
            return;
        }
        try {
            const plugin = (window as any).browserPlugin as any;
            if (!plugin?.getPreloadPath) return;
            const preloadUrl = await plugin.getPreloadPath();
            if (!preloadUrl) {
                console.warn("[browser-plugin] preload path not detected, link interception disabled");
                return;
            }
            // 同时用 setAttribute 和属性赋值，最大化兼容性
            this.webview.setAttribute("preload", preloadUrl);
            try {
                this.webview.preload = preloadUrl;
            } catch {}
            // 验证是否设置成功
            const actual = this.webview.getAttribute("preload") || (this.webview as any).preload;
            if (actual) {
                console.log("[browser-plugin] preload applied:", actual);
            } else {
                console.warn("[browser-plugin] preload setAttribute failed silently");
            }
        } catch (e) {
            // 路径探测失败时静默忽略，webview 仍能加载页面（只是失去新窗口拦截）
            console.warn("[browser-plugin] applyPreload failed:", e);
        }
    }

    private buildDom(): HTMLElement {
        const root = el("div", "sy-browser-tab");
        const content = el("div", "sy-browser-content");
        content.appendChild(this.createWebviewElement() as unknown as HTMLElement);
        root.appendChild(content);
        return root;
    }

    /**
     * 创建 webview 元素。
     * webpreferences: 允许 preload 中 require('electron')（contextIsolation 关闭）
     *   允许 sub-frame nodeIntegration（preload 注入子框架）
     *   允许加载本地文件（webSecurity 不关闭，避免破坏站点 CSS/CSP）
     * 分屏/拖动导致 webview 损坏时，重建也走这里保证属性一致。
     */
    private createWebviewElement(): IWebviewTag {
        const webview = document.createElement("webview") as unknown as IWebviewTag;
        webview.setAttribute("src", "about:blank");
        webview.setAttribute("allowpopups", "");
        webview.setAttribute("partition", BROWSER_PARTITION);
        webview.setAttribute("webpreferences", "contextIsolation=no,nodeIntegrationInSubFrames=yes");
        // 在构建 webview 时立即设置 preload（若路径已缓存），确保首次加载就生效
        try {
            const plugin = (window as any).browserPlugin as any;
            const cached = plugin?.getPreloadPathSync?.();
            if (cached && this.settings.enablePreload) {
                webview.setAttribute("preload", cached);
            }
        } catch {}
        (webview as unknown as HTMLElement).style.cssText = "flex:1;width:100%;border:0;";
        return webview;
    }

    /** 启动 webview 健康监测（损坏自动重建） */
    private startHealthMonitor(): void {
        if (this.healthTimer) return;
        this.healthTimer = setInterval(async () => {
            if (this.disposed || this.rebuilding) return;
            // 首次加载完成前、以及任何导航进行中都不探测：
            // 加载期间页面主线程繁忙/进程切换会让 executeJavaScript 探测超时，
            // 新页签初始 src 是 about:blank，此时误判重建会让页签永远停在空白页
            if (!this.controller.hasCompletedInitialLoad() || this.controller.isLoading()) return;
            try {
                const healthy = await this.controller.isHealthy();
                if (!healthy && !this.disposed && !this.rebuilding) {
                    // 连续两次失败才判定损坏，避免偶发超时误判
                    this.healthFailCount++;
                    if (this.healthFailCount >= 2) {
                        this.healthFailCount = 0;
                        console.warn("[browser-plugin] webview broken (moved in DOM?), rebuilding");
                        await this.rebuildWebview();
                    }
                } else {
                    this.healthFailCount = 0;
                }
            } catch {}
        }, 2000);
    }

    /**
     * 重建 webview：新建同属性元素替换旧元素，重新挂载控制器并恢复当前 URL。
     * 用于分屏/页签搬移等 DOM 重新挂载导致 webview guest 损坏的场景。
     */
    private async rebuildWebview(): Promise<void> {
        if (this.disposed || this.rebuilding) return;
        this.rebuilding = true;
        try {
            const savedUrl = this.controller.getCurrentUrl();
            const container = this.element.querySelector(".sy-browser-content");
            if (!container) return;
            const newWebview = this.createWebviewElement();
            if (this.settings.userAgent) {
                newWebview.useragent = this.settings.userAgent;
            }
            this.webview.replaceWith(newWebview);
            this.webview = newWebview;
            this.controller.reattach(newWebview);
            // 重建后的 webview 恢复 UA（商店页需重新伪装 Edge）
            this.edgeUaActive = false;
            if (savedUrl) {
                // 无条件恢复（加载未提交时 getURL 是 about:blank，getCurrentUrl 可能取不到）
                this.syncUserAgent(savedUrl);
                await this.controller.loadURL(savedUrl);
            }
            console.log("[browser-plugin] webview rebuilt, url:", savedUrl);
        } catch (e) {
            console.error("[browser-plugin] rebuildWebview failed:", e);
        } finally {
            this.rebuilding = false;
        }
    }

    private async onToolbarAction(action: string, payload?: any): Promise<void> {
        switch (action) {
            case "back":
                this.controller.goBack();
                break;
            case "forward":
                this.controller.goForward();
                break;
            case "reload":
                this.controller.reload(false);
                break;
            case "forceReload":
                this.controller.reload(true);
                break;
            case "stop":
                this.controller.stop();
                break;
            case "home":
                this.controller.loadURL(this.settings.homepage);
                break;
            case "toggleBookmark":
                await this.toggleBookmark();
                break;
            case "menu":
                this.showMenu(payload?.x, payload?.y);
                break;
            case "findInPage":
                this.controller.findInPage(payload?.text ?? "", payload?.forward ?? true, true);
                break;
            case "openExternal":
                await this.openInDefaultBrowser();
                break;
        }
    }

    private async toggleBookmark(): Promise<void> {
        const url = this.controller.getCurrentUrl();
        if (!url || url === "about:blank") return;
        const title = this.controller.getCurrentTitle() || url;
        await this.deps.bookmarks.toggle({ title, url });
        this.updateBookmarkButton(url);
    }

    /** 在系统默认浏览器中打开当前页面 URL */
    private async openInDefaultBrowser(): Promise<void> {
        const url = this.controller.getCurrentUrl();
        if (!url || !/^https?:\/\//i.test(url)) {
            showMessage(this.deps.i18n.openExternal);
            return;
        }
        try {
            const electron = (window as any).require?.("electron") || (globalThis as any).require?.("electron");
            const shell = electron?.shell;
            if (shell?.openExternal) {
                await shell.openExternal(url);
            } else {
                // 回退：用思源的方式打开
                window.open(url, "_blank");
            }
        } catch (e) {
            console.warn("[browser-plugin] openInDefaultBrowser failed:", e);
            window.open(url, "_blank");
        }
    }

    private updateBookmarkButton(url: string): void {
        const bookmarked = !!this.deps.bookmarks.find(url);
        this.toolbar.setBookmarked(bookmarked);
    }

    private showMenu(x?: number, y?: number): void {
        try {
            const menu = new Menu("sy-browser-menu");
            if (!menu) {
                console.warn("[browser-plugin] Menu constructor returned null");
                return;
            }
            menu.addItem({
                id: "settings",
                iconHTML: "",
                label: this.deps.i18n.settings,
                click: () => {
                    try {
                        const dlg = new SettingsDialog(this.deps.settings, this.deps.i18n);
                        dlg.extensionOpener = () => {
                            const plugin = (window as any).browserPlugin as any;
                            plugin?.extensionHost?.openManager(this.deps.i18n);
                        };
                        dlg.open();
                    } catch (e) {
                        console.error("[browser-plugin] open settings dialog failed:", e);
                    }
                },
            });
            menu.addItem({
                id: "history",
                iconHTML: "",
                label: this.deps.i18n.history,
                click: () => {
                    document.dispatchEvent(new CustomEvent("sy-browser-open-dock", { detail: { type: "history" } }));
                },
            });
            menu.addItem({
                id: "bookmarks",
                iconHTML: "",
                label: this.deps.i18n.bookmarks,
                click: () => {
                    document.dispatchEvent(new CustomEvent("sy-browser-open-dock", { detail: { type: "bookmarks" } }));
                },
            });
            menu.addItem({
                id: "downloads",
                iconHTML: "",
                label: this.deps.i18n.downloads,
                click: () => {
                    document.dispatchEvent(new CustomEvent("sy-browser-open-dock", { detail: { type: "downloads" } }));
                },
            });
            menu.addSeparator();
            menu.addItem({
                id: "inspect",
                iconHTML: "",
                label: this.deps.i18n.inspect,
                click: () => {
                    try {
                        this.webview.openDevTools?.();
                    } catch {}
                },
            });
            // 优先使用传入的点击坐标，备选按钮位置
            let px = x;
            let py = y;
            if (px == null || py == null) {
                const btn = this.toolbar.element.querySelector('[data-act="menu"]') as HTMLElement;
                const rect = btn.getBoundingClientRect();
                px = rect.right;
                py = rect.bottom;
            }
            console.log("[browser-plugin] showMenu at:", px, py);
            menu.open({ x: px, y: py });
        } catch (e) {
            console.error("[browser-plugin] showMenu failed:", e);
        }
    }

    /** 公共 API（供快捷键调用） */
    reload(): void {
        this.controller.reload(false);
    }
    goBack(): void {
        this.controller.goBack();
    }
    goForward(): void {
        this.controller.goForward();
    }
    focusUrl(): void {
        this.toolbar.focusUrl();
    }
    findInPage(text: string): void {
        this.controller.findInPage(text);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
        this.controller.dispose();
        this.element.remove();
    }
}
