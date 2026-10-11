import { fetchSyncPost, showMessage } from "siyuan";
import readabilitySource from "../assets/Readability.js";
import clipScriptSource from "../assets/clipScript.js";

/**
 * 网页摘录：与思源官方浏览器剪藏扩展（siyuan-chrome）效果保持一致。
 *
 * 管线：
 * 1. 在 webview 页面上下文执行 clipScript.js（+ Readability.js）：
 *    Readability 提取正文（含官方扩展的全部前处理），收集图片转 base64
 * 2. 调用内核 /api/extension/copy（lute 把 DOM 转 Markdown，并按开关下载资源文件）
 * 3. 整页摘录：按官方默认模板组装 Markdown，/api/filetree/createDocWithMd 建文档
 *    选区摘录：Markdown 复制到剪贴板（与官方扩展行为一致）
 * 4. 图片抓取失败时调用 /api/format/netImg2LocalAssets 兜底转换
 */

/** 剪藏前处理选项（对应官方扩展 exp 选项，默认全部关闭） */
export interface ClipExpOptions {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    removeImgLink: boolean;
    span: boolean;
    svgToImg: boolean;
}

export interface ClipOptions {
    mode: "article" | "part";
    notebookId: string;
    /** 保存路径（人类可读路径，如 /父文档/子文档，默认 / 根下）；支持 {{...}} sprig 模板 */
    parentPath: string;
    /** 标签（逗号分隔） */
    tags: string;
    /** 是否下载资源文件到思源 assets */
    assets: boolean;
    exp: ClipExpOptions;
}

interface ClipPayload {
    ok: boolean;
    error?: string;
    mode?: string;
    dom: string;
    files: Record<string, { type: string; data: string }>;
    title: string;
    siteName: string;
    excerpt: string;
    href: string;
    fetchFileErr: boolean;
}

/** 在 webview 中执行剪藏脚本，返回收集结果 */
async function runClipScript(webview: any, opts: ClipOptions): Promise<ClipPayload> {
    const config = {
        mode: opts.mode,
        assets: opts.assets,
        exp: opts.exp,
    };
    const script =
        "window.__syBrowserClipConfig = " + JSON.stringify(config) + ";\n" +
        readabilitySource + "\n;\n" +
        clipScriptSource;
    const raw = await webview.executeJavaScript(script);
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    return payload as ClipPayload;
}

/** 列出思源所有笔记本（设置页用） */
export async function listNotebooks(): Promise<Array<{ id: string; name: string }>> {
    try {
        const resp: any = await fetchSyncPost("/api/notebook/lsNotebooks", {});
        const notebooks = resp?.data?.notebooks || [];
        return notebooks
            .filter((n: any) => !n.closed)
            .map((n: any) => ({ id: n.id, name: n.name }));
    } catch {
        return [];
    }
}

// === Markdown 组装（与官方扩展 background.js 保持一致）===

/** 官方扩展默认剪藏模板 */
export const CLIP_DEFAULT_TEMPLATE =
    "---\n\n" +
    '- ${title}${siteName ? " - " + siteName : ""}\n' +
    "- [${urlDecoded}](${url}) \n" +
    '${excerpt ? "- " + excerpt : ""}\n' +
    "- ${date} ${time}\n" +
    "\n---\n\n" +
    "${content}";

function formatClipExcerpt(excerpt: string): string {
    let text = (excerpt || "").trim();
    if (text === "") return "";
    text = text.replace(/\n{3,}/g, "\n\n");
    // 从第二行开始，每行前面加两个空格
    text = text.replace(/\n/g, "\n  ");
    return text.trim();
}

function decodeClipUrl(href: string): string {
    try {
        return decodeURIComponent(href);
    } catch {
        return href;
    }
}

function getClipDateTime(): string {
    const now = new Date();
    const p = (n: number) => (n < 10 ? "0" + n : "" + n);
    return (
        now.getFullYear() + "-" + p(now.getMonth() + 1) + "-" + p(now.getDate()) +
        " " + p(now.getHours()) + ":" + p(now.getMinutes()) + ":" + p(now.getSeconds())
    );
}

function getClipSimpleDateTime(): { date: string; time: string } {
    const now = new Date();
    return { date: now.toISOString().slice(0, 10), time: now.toTimeString().slice(0, 5) };
}

/** 模板渲染（支持 ${var} 与 ${cond ? "a" : b} 条件表达式） */
function renderClipTemplate(template: string, data: Record<string, any>): string {
    return template.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
        const conditionalMatch = key.match(/(.+?)\s*\?\s*(.*?)\s*:\s*(.*)/);
        if (conditionalMatch) {
            const conditionKey = conditionalMatch[1].trim();
            const trueValueString = conditionalMatch[2].trim();
            const falseValueString = conditionalMatch[3].trim();
            const condition = conditionKey.split(".").reduce((obj: any, prop) => obj && obj[prop], data);
            const getValue = (valueStr: string): string => {
                if (
                    (valueStr.startsWith("'") && valueStr.endsWith("'")) ||
                    (valueStr.startsWith('"') && valueStr.endsWith('"'))
                ) {
                    return valueStr.slice(1, -1);
                }
                const parts = valueStr.split("+").map((part) => part.trim());
                let result = "";
                for (const part of parts) {
                    if ((part.startsWith("'") && part.endsWith("'")) || (part.startsWith('"') && part.endsWith('"'))) {
                        result += part.slice(1, -1);
                    } else {
                        const variableValue = part.split(".").reduce((obj: any, prop) => obj && obj[prop], data);
                        result += variableValue !== undefined ? variableValue : "";
                    }
                }
                return result;
            };
            return condition ? getValue(trueValueString) : getValue(falseValueString);
        }
        const value = key.split(".").reduce((obj: any, prop) => obj && obj[prop], data);
        return value !== undefined ? value : "";
    });
}

/** 模板渲染失败时的默认格式 */
function getDefaultClipMarkdown(p: ClipPayload, contentMd: string): string {
    let markdown = "---\n\n* " + (p.title || "Untitled");
    const siteName = p.siteName || "";
    if ("" !== siteName) {
        markdown += " - " + siteName;
    }
    markdown += "\n";
    markdown += "* " + "[" + decodeClipUrl(p.href) + "](" + p.href + ")\n";
    const excerpt = formatClipExcerpt(p.excerpt);
    if ("" !== excerpt) {
        markdown += "* " + excerpt + "\n";
    } else {
        markdown += "\n";
    }
    markdown += "* " + getClipDateTime() + "\n\n---\n\n" + contentMd;
    return markdown;
}

function buildClipMarkdown(p: ClipPayload, contentMd: string): string {
    const excerpt = formatClipExcerpt(p.excerpt);
    const { date, time } = getClipSimpleDateTime();
    const templateData = {
        title: p.title || "Untitled",
        siteName: p.siteName || "",
        excerpt: excerpt || "",
        url: p.href,
        urlDecoded: decodeClipUrl(p.href),
        date,
        time,
        tags: "",
        content: contentMd,
    };
    try {
        return renderClipTemplate(CLIP_DEFAULT_TEMPLATE, templateData);
    } catch (e) {
        console.error("[browser-plugin] template rendering error:", e);
        return getDefaultClipMarkdown(p, contentMd);
    }
}

/** 规范化文档保存路径（与官方扩展 normalizeClipDocumentPath 一致） */
function normalizeClipDocumentPath(parentPath: string, title: string): string {
    let path = String(parentPath || "").trim().split("\\").join("/");
    path = path.replace(/\/{2,}/g, "/");
    if (!path.startsWith("/")) path = "/" + path;
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return (path === "/" ? "" : path) + "/" + title;
}

/** sprig 模板路径渲染 */
async function renderSprigPath(template: string): Promise<string | null> {
    try {
        const resp: any = await fetchSyncPost("/api/template/renderSprig", { template });
        if (resp?.code === 0 && typeof resp.data === "string") {
            return resp.data;
        }
        console.warn("[browser-plugin] renderSprig failed:", resp);
        return null;
    } catch {
        return null;
    }
}

function dataUrlToBlob(dataUrl: string): Promise<Blob> {
    return fetch(dataUrl).then((r) => r.blob());
}

/** 摘录进度消息 id（思源 showMessage 同 id 调用会原地更新内容与消失计时）：
 *  大页面 /api/extension/copy（assets 开启时内核同步下载全部网络图片）可持续
 *  数十秒到数分钟 —— 进行中提示必须长显并在此 id 下流转，否则 2s 后消失，
 *  用户长时间无反馈（完成提示看起来"过很久才出现"）。 */
const EXCERPT_PROGRESS_ID = "sy-excerpt-progress";
const EXCERPT_PROGRESS_TIMEOUT = 600000;

/**
 * 执行剪藏：从 webview 收集内容并保存到思源。
 * - article：整页摘录（Readability），创建新文档
 * - part：选区摘录，Markdown 复制到剪贴板
 */
export async function clipToSiYuan(
    webview: any,
    opts: ClipOptions,
    i18n: Record<string, string>
): Promise<void> {
    if (opts.mode === "article") {
        if (!opts.notebookId) {
            showMessage(i18n.excerptNotebookRequired || (i18n.excerptFailed + ": " + (i18n.excerptNotebook || "notebook") + " ?"), 3000, "error");
            return;
        }
        // 校验笔记本仍存在且处于打开状态：设置里保存的 ID 可能因笔记本被删除/关闭/换工作空间而失效，
        // 直接调 createDocWithMd 内核只会报"查询笔记本失败"，用户无从下手
        const notebooks = await listNotebooks();
        if (!notebooks.some((n) => n.id === opts.notebookId)) {
            showMessage(i18n.excerptNotebookInvalid || "保存笔记本不存在或已关闭，请到设置中重新选择", 5000, "error");
            return;
        }
    }

    showMessage(i18n.excerpt + "...", EXCERPT_PROGRESS_TIMEOUT, "info", EXCERPT_PROGRESS_ID);

    let payload: ClipPayload;
    try {
        payload = await runClipScript(webview, opts);
    } catch (e: any) {
        console.error("[browser-plugin] runClipScript failed:", e);
        showMessage(i18n.excerptFailed + ": " + (e?.message || e), 4000, "error", EXCERPT_PROGRESS_ID);
        return;
    }
    if (!payload?.ok) {
        const reason = payload?.error === "no_selection" ? (i18n.excerptNoSelection || "no selection")
            : payload?.error === "readability_failed" ? (i18n.excerptReadabilityFailed || "readability failed")
            : (payload?.error || "extract failed");
        showMessage(i18n.excerptFailed + ": " + reason, 4000, "error", EXCERPT_PROGRESS_ID);
        return;
    }
    if (!payload.dom) {
        showMessage(i18n.excerptFailed + ": content empty", 3000, "error", EXCERPT_PROGRESS_ID);
        return;
    }

    // 1. 调用内核 /api/extension/copy：lute 转 Markdown + 下载资源
    let md = "";
    let withMath: boolean | undefined;
    try {
        const form = new FormData();
        form.append("dom", payload.dom);
        for (const key of Object.keys(payload.files || {})) {
            const f = payload.files[key];
            form.append(key, await dataUrlToBlob(f.data));
        }
        form.append("notebook", opts.notebookId || "");
        form.append("href", payload.href);
        form.append("tags", opts.tags || "");
        form.append("clipType", opts.mode);
        form.append("assets", String(opts.assets));

        const resp = await fetch("/api/extension/copy", { method: "POST", body: form });
        const copyResult = await resp.json();
        if (copyResult.code < 0) {
            showMessage(i18n.excerptFailed + ": " + copyResult.msg, 4000, "error", EXCERPT_PROGRESS_ID);
            return;
        }
        md = copyResult.data?.md || "";
        withMath = copyResult.data?.withMath;
    } catch (e: any) {
        console.error("[browser-plugin] /api/extension/copy failed:", e);
        showMessage(i18n.excerptFailed + ": " + (e?.message || e), 4000, "error", EXCERPT_PROGRESS_ID);
        return;
    }

    // 2. 选区剪藏：复制 Markdown 到剪贴板（与官方扩展一致）
    if (opts.mode === "part") {
        const { copyText } = await import("../utils/dom");
        await copyText(md);
        showMessage(i18n.excerptComplete + " → " + (i18n.clipboard || "clipboard"), 3000, "info", EXCERPT_PROGRESS_ID);
        return;
    }

    if (!md) {
        showMessage(i18n.excerptFailed + ": empty markdown", 3000, "error", EXCERPT_PROGRESS_ID);
        return;
    }

    // 3. 组装 Markdown 并创建文档
    const title = (payload.title ? payload.title : "Untitled").replace(/[\\/]/g, "／") || "Untitled";
    const markdown = buildClipMarkdown(payload, md);

    let parentPath = opts.parentPath || "/";
    if (parentPath.includes("{{")) {
        const rendered = await renderSprigPath(parentPath);
        if (rendered == null) {
            showMessage(i18n.excerptFailed + ": renderSprig", 4000, "error", EXCERPT_PROGRESS_ID);
            return;
        }
        parentPath = rendered;
    }
    const path = normalizeClipDocumentPath(parentPath, title);

    try {
        const resp: any = await fetchSyncPost("/api/filetree/createDocWithMd", {
            notebook: opts.notebookId,
            parentID: "",
            tags: opts.tags || "",
            path,
            markdown,
            withMath,
            clippingHref: payload.href,
            listDocTree: false,
        });
        if (resp?.code !== 0) {
            showMessage(i18n.excerptFailed + ": " + (resp?.msg || "unknown"), 4000, "error", EXCERPT_PROGRESS_ID);
            return;
        }
        const docId = resp.data;
        showMessage(i18n.excerptComplete + ": " + title, 3000, "info", EXCERPT_PROGRESS_ID);

        // 4. 图片抓取失败 → 内核网络图片转本地兜底
        if (payload.fetchFileErr && docId) {
            fetch("/api/format/netImg2LocalAssets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: docId, url: payload.href }),
            }).catch(() => {});
        }
    } catch (e: any) {
        console.error("[browser-plugin] createDoc failed:", e);
        showMessage(i18n.excerptFailed + ": " + (e?.message || e), 4000, "error", EXCERPT_PROGRESS_ID);
    }
}
