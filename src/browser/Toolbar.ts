import type { BrowserSettings, IWebviewTag } from "../types";
import { normalizeUrl } from "../utils/url";
import { el, clearChildren } from "../utils/dom";

/** 工具栏按钮动作 */
export type ToolbarAction =
    | "back"
    | "forward"
    | "reload"
    | "forceReload"
    | "stop"
    | "home"
    | "submit"
    | "toggleBookmark"
    | "findInPage"
    | "openExternal";

/** 工具栏回调 */
export interface ToolbarCallbacks {
    onAction(action: ToolbarAction, payload?: any): void;
    onUrlSubmit(url: string): void;
    onFindInPage(text: string): void;
}

/** 扩展图标区要展示的一项 */
export interface IToolbarExtension {
    /** 插件内部的稳定 id */
    id: string;
    name: string;
    /** 图标 URL（chrome-extension:// 或 file://）；为空时用名称首字兜底 */
    iconUrl?: string;
    /** 悬停提示 */
    title: string;
}

export interface IToolbarExtCallbacks {
    /** 列出要显示图标的扩展 */
    list(): IToolbarExtension[];
    /** 点击图标：宿主自行弹出面板 */
    onClick(extId: string, anchor: HTMLElement): void;
}

/** 工具栏 UI */
export class Toolbar {
    readonly element: HTMLElement;
    private urlbar: HTMLInputElement;
    private backBtn: HTMLButtonElement;
    private forwardBtn: HTMLButtonElement;
    private reloadBtn: HTMLButtonElement;
    private bookmarkBtn: HTMLButtonElement;
    private findbar: HTMLInputElement;
    private findbarWrap: HTMLElement;
    private findbarResult: HTMLElement;
    private loadingBar: HTMLElement;
    private i18n: Record<string, string>;
    private cb: ToolbarCallbacks;
    private settings: BrowserSettings;
    /** 扩展图标区容器（构造后由 setExtensionBar 填充） */
    private extBar: HTMLElement;
    private extCb?: IToolbarExtCallbacks;

    constructor(i18n: Record<string, string>, cb: ToolbarCallbacks, settings: BrowserSettings) {
        this.i18n = i18n;
        this.cb = cb;
        this.settings = settings;
        this.element = this.build();
        this.urlbar = this.element.querySelector(".sy-browser-urlbar")!;
        this.backBtn = this.element.querySelector('[data-act="back"]')!;
        this.forwardBtn = this.element.querySelector('[data-act="forward"]')!;
        this.reloadBtn = this.element.querySelector('[data-act="reload"]')!;
        this.bookmarkBtn = this.element.querySelector('[data-act="bookmark"]')!;
        this.findbarWrap = this.element.querySelector(".sy-browser-findbar-wrap")!;
        this.findbar = this.element.querySelector(".sy-browser-findbar")!;
        this.findbarResult = this.element.querySelector(".sy-browser-findbar-result")!;
        this.loadingBar = this.element.querySelector(".sy-browser-loading-bar")!;
        this.extBar = this.element.querySelector(".sy-browser-extbar")!;
        this.bindEvents();
    }

    /** 接上扩展图标数据源（没有扩展宿主时可不调，图标区保持空） */
    setExtensionCallbacks(cb: IToolbarExtCallbacks): void {
        this.extCb = cb;
        this.renderExtensionBar();
    }

    /** 扩展增删/启停后重画图标区 */
    renderExtensionBar(): void {
        if (!this.extBar) return;
        clearChildren(this.extBar);
        // 常驻入口：管理扩展。无论扩展数据是否就绪、有没有装扩展都显示 ——
        // 否则"没装扩展/数据未加载"时图标区整块消失，入口就没 了。
        const mgrBtn = el("button", "sy-browser-extbtn");
        mgrBtn.type = "button";
        mgrBtn.title = this.i18n.extManager || "Chrome 扩展";
        mgrBtn.dataset.extId = "__manager__";
        mgrBtn.textContent = "🧩";
        mgrBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this.extCb?.onClick("__manager__", mgrBtn);
        });
        this.extBar.appendChild(mgrBtn);

        if (!this.extCb) return;
        let items: IToolbarExtension[] = [];
        try {
            items = this.extCb.list() || [];
        } catch {
            return;
        }
        for (const ext of items) {
            const btn = el("button", "sy-browser-extbtn");
            btn.type = "button";
            btn.title = ext.title || ext.name;
            btn.dataset.extId = ext.id;
            if (ext.iconUrl) {
                const img = document.createElement("img");
                img.src = ext.iconUrl;
                img.alt = "";
                // 图标加载失败就不占位，避免显示一个破图
                img.addEventListener("error", () => { img.remove(); });
                btn.appendChild(img);
            } else {
                btn.textContent = (ext.name || "?").trim().charAt(0).toUpperCase();
            }
            btn.addEventListener("click", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.extCb?.onClick(ext.id, btn);
            });
            this.extBar.appendChild(btn);
        }
    }

    private build(): HTMLElement {
        const root = el("div", "sy-browser-toolbar");
        root.innerHTML = `
            <div class="sy-browser-loading-bar"></div>
            <div class="sy-browser-toolbar-row">
                <button class="sy-browser-btn" data-act="back" title="${this.i18n.back}" disabled>←</button>
                <button class="sy-browser-btn" data-act="forward" title="${this.i18n.forward}" disabled>→</button>
                <button class="sy-browser-btn" data-act="reload" title="${this.i18n.reload}">⟳</button>
                <button class="sy-browser-btn" data-act="home" title="${this.i18n.home}">⌂</button>
                <input class="sy-browser-urlbar" type="text" placeholder="${this.i18n.addressBar}" spellcheck="false" />
                <button class="sy-browser-btn" data-act="bookmark" title="${this.i18n.addBookmark}">☆</button>
                <button class="sy-browser-btn" data-act="find" title="${this.i18n.findInPage}">🔍</button>
                <button class="sy-browser-btn" data-act="openExternal" title="${this.i18n.openExternal}">↗</button>
                <span class="sy-browser-extbar"></span>
            </div>
            <div class="sy-browser-findbar-wrap" style="display:none;">
                <input class="sy-browser-findbar" type="text" placeholder="${this.i18n.findInPage}" spellcheck="false" />
                <span class="sy-browser-findbar-result"></span>
                <button class="sy-browser-btn" data-act="findNext">↓</button>
                <button class="sy-browser-btn" data-act="findPrev">↑</button>
                <button class="sy-browser-btn" data-act="findClose">✕</button>
            </div>
        `;
        return root;
    }

    private bindEvents(): void {
        this.element.addEventListener("click", (e) => {
            const target = e.target as HTMLElement;
            const btn = target.closest("[data-act]") as HTMLElement | null;
            if (!btn) return;
            const act = btn.dataset.act;
            switch (act) {
                case "back":
                    this.cb.onAction("back");
                    break;
                case "forward":
                    this.cb.onAction("forward");
                    break;
                case "reload":
                    if (e.shiftKey) this.cb.onAction("forceReload");
                    else this.cb.onAction("reload");
                    break;
                case "home":
                    this.cb.onAction("home");
                    break;
                case "bookmark":
                    this.cb.onAction("toggleBookmark");
                    break;
                case "find":
                    this.toggleFindbar(true);
                    break;
                case "findNext":
                    this.cb.onAction("findInPage", { forward: true, text: this.findbar.value });
                    break;
                case "findPrev":
                    this.cb.onAction("findInPage", { forward: false, text: this.findbar.value });
                    break;
                case "findClose":
                    this.toggleFindbar(false);
                    break;
                case "stop":
                    this.cb.onAction("stop");
                    break;
                case "openExternal":
                    this.cb.onAction("openExternal");
                    break;
            }
        });

        this.urlbar.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const raw = this.urlbar.value;
                const url = normalizeUrl(raw, this.settings);
                this.cb.onUrlSubmit(url);
            } else if (e.key === "Escape") {
                this.urlbar.blur();
            }
        });

        this.urlbar.addEventListener("focus", () => {
            this.urlbar.select();
        });

        this.findbar.addEventListener("input", () => {
            this.cb.onFindInPage(this.findbar.value);
        });
        this.findbar.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                // Enter 向前查找下一个，Shift+Enter 向后查找上一个
                this.cb.onAction("findInPage", { forward: !e.shiftKey, text: this.findbar.value });
            } else if (e.key === "Escape") {
                this.toggleFindbar(false);
            }
        });
    }

    private toggleFindbar(show: boolean): void {
        this.findbarWrap.style.display = show ? "flex" : "none";
        if (show) {
            this.findbar.focus();
        } else {
            this.findbar.value = "";
            this.findbarResult.textContent = "";
            this.cb.onFindInPage("");
        }
    }

    /** 设置查找匹配结果数显示 */
    setFindResult(activeMatch: number, matches: number): void {
        if (!matches) {
            this.findbarResult.textContent = this.findbar.value ? "0/0" : "";
        } else {
            this.findbarResult.textContent = `${activeMatch}/${matches}`;
        }
    }

    /** 设置地址栏内容（不触发回调） */
    setUrl(url: string): void {
        if (document.activeElement === this.urlbar) return;
        this.urlbar.value = url;
    }

    /** 更新前进/后退按钮可用状态 */
    setNavState(canBack: boolean, canForward: boolean): void {
        this.backBtn.disabled = !canBack;
        this.forwardBtn.disabled = !canForward;
    }

    /** 设置加载状态 */
    setLoading(loading: boolean): void {
        this.loadingBar.style.opacity = loading ? "1" : "0";
        this.reloadBtn.textContent = loading ? "✕" : "⟳";
        this.reloadBtn.dataset.act = loading ? "stop" : "reload";
    }

    /** 切换收藏按钮高亮状态 */
    setBookmarked(bookmarked: boolean): void {
        this.bookmarkBtn.textContent = bookmarked ? "★" : "☆";
        this.bookmarkBtn.classList.toggle("is-active", bookmarked);
    }

    /** 更新设置（用于地址栏规范化） */
    updateSettings(settings: BrowserSettings): void {
        this.settings = settings;
    }

    /** 聚焦地址栏并全选 */
    focusUrl(): void {
        this.urlbar.focus();
        this.urlbar.select();
    }

    get urlbarElement(): HTMLInputElement {
        return this.urlbar;
    }
}
