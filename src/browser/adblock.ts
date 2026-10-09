/**
 * 内置广告过滤（元素隐藏）。
 *
 * 只做元素隐藏（Adblock 语法中的 ## / #@# 规则），不做网络层拦截 —— 插件运行在渲染
 * 进程拿不到 webRequest API，扩展宿主也不执行 background，网络级拦截在当前架构不可行。
 * CSS 一次注入后持续生效，页面脚本后续动态插入的广告节点同样会被隐藏。
 *
 * 规则语法（每行一条，与 Adblock 元素隐藏语法兼容，可直接粘贴 EasyList 类列表的
 * 元素隐藏部分）：
 *   ##selector                  通用规则（所有站点生效）
 *   example.com##selector       仅 example.com 及其子域名生效
 *   a.com,b.com##selector       多域名
 *   example.com#@#selector      例外规则（豁免同名隐藏规则）
 *   ! 注释 / # 注释 / 空行
 */

export interface IParsedAdRules {
    generic: string[];
    byDomain: Map<string, string[]>;
    exceptions: Set<string>;
}

function parseRuleLine(line: string): { domains: string[]; selector: string; exception: boolean } | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("!")) return null;
    // "# ..." 是注释；"##" / "#@#" 开头是规则本身
    if (/^#(?![#@])/.test(trimmed)) return null;
    let exception = false;
    let body = trimmed;
    if (body.startsWith("#@#")) {
        return { domains: [], selector: body.slice(3).trim(), exception: true };
    }
    const at = body.indexOf("#@#");
    if (at > 0) {
        exception = true;
        body = body.slice(0, at) + "##" + body.slice(at + 3);
    }
    const sep = body.indexOf("##");
    if (sep < 0) return null; // 非 element-hiding 规则（URL 拦截类）忽略
    const domains = sep === 0 ? [] : body.slice(0, sep).split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    const selector = body.slice(sep + 2).trim();
    if (!selector) return null;
    return { domains, selector, exception };
}

/** 解析规则文本（内置规则 + 用户自定义规则共用） */
export function parseAdRules(text: string): IParsedAdRules {
    const parsed: IParsedAdRules = { generic: [], byDomain: new Map(), exceptions: new Set() };
    for (const line of String(text || "").split(/\r?\n/)) {
        const rule = parseRuleLine(line);
        if (!rule) continue;
        if (rule.exception) {
            parsed.exceptions.add(rule.selector);
            continue;
        }
        if (rule.domains.length === 0) {
            parsed.generic.push(rule.selector);
        } else {
            for (const d of rule.domains) {
                if (!parsed.byDomain.has(d)) parsed.byDomain.set(d, []);
                parsed.byDomain.get(d)!.push(rule.selector);
            }
        }
    }
    return parsed;
}

/** domain 规则匹配 hostname（自身或子域名） */
function domainMatches(hostname: string, domain: string): boolean {
    return hostname === domain || hostname.endsWith("." + domain);
}

/** 选择器有效性校验（非浏览器环境跳过） */
function isValidSelector(selector: string): boolean {
    if (typeof document === "undefined") return true;
    try {
        document.querySelector(selector);
        return true;
    } catch {
        return false;
    }
}

/**
 * 生成指定 URL 页面的广告隐藏 CSS。无命中规则时返回空串。
 * 例外选择器会从隐藏列表中剔除（同名豁免）。
 */
export function buildAdBlockCss(rawUrl: string, customRules: string, builtinRules: string): string {
    let hostname = "";
    try {
        hostname = new URL(rawUrl).hostname.toLowerCase();
    } catch {
        return "";
    }
    const user = parseAdRules(customRules);
    const builtin = parseAdRules(builtinRules);
    const selectors = new Set<string>();
    const push = (list: string[]) => {
        for (const sel of list) {
            if (!selectors.has(sel) && !user.exceptions.has(sel) && !builtin.exceptions.has(sel) && isValidSelector(sel)) {
                selectors.add(sel);
            }
        }
    };
    push(user.generic);
    push(builtin.generic);
    for (const [domain, sels] of user.byDomain) {
        if (domainMatches(hostname, domain)) push(sels);
    }
    for (const [domain, sels] of builtin.byDomain) {
        if (domainMatches(hostname, domain)) push(sels);
    }
    if (selectors.size === 0) return "";
    return [...selectors].map((sel) => `${sel}{display:none!important}`).join("\n");
}
