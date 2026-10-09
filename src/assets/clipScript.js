/*
 * 思源浏览器插件 - 网页剪藏注入脚本
 *
 * 在 webview 页面上下文中执行（配合 Readability.js 一起注入）。
 * 逻辑与思源官方浏览器剪藏扩展（siyuan-chrome content.js）保持一致：
 *   1. MathJax 公式标记 data-formula
 *   2. Readability 前处理（粗斜体/下划线样式、span 换行、SVG、图片链接、语雀适配、MSN 适配）
 *   3. Readability 提取正文
 *   4. 收集图片 → fetch → base64（页面上下文内自动带 cookie/referer）
 *   5. 返回 {dom, files, title, siteName, excerpt, href, fetchFileErr} 的 JSON
 *
 * 配置从 window.__syBrowserClipConfig 读取：
 *   { mode: "article"|"part", assets: boolean, exp: {bold,italic,underline,removeImgLink,span,svgToImg} }
 */
(async function () {
    const config = window.__syBrowserClipConfig || {};
    const mode = config.mode || "article";
    const exp = config.exp || {};
    const result = { ok: false, mode: mode, dom: "", files: {}, title: "", siteName: "", excerpt: "", href: window.location.href, fetchFileErr: false };

    try {
        if (typeof Readability !== "function") {
            result.error = "Readability lib missing";
            return JSON.stringify(result);
        }

        const convertBlobToBase64 = (blob) =>
            new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = reject;
                reader.onload = () => resolve(reader.result);
                reader.readAsDataURL(blob);
            });

        const SIYUAN_CLIP_IMAGE_INDEX_ATTR = "data-siyuan-clip-image-index";

        const isYuquePage = () => {
            return window.location.hostname === "yuque.com" || window.location.hostname.endsWith(".yuque.com");
        };

        const getImageSource = (image) => {
            const source = image.getAttribute("src") ||
                image.currentSrc ||
                image.getAttribute("data-src") ||
                image.getAttribute("data-original") ||
                image.getAttribute("data-origin-src") ||
                image.getAttribute("data-lazy-src");
            if (!source) {
                return "";
            }
            try {
                return new URL(source, document.baseURI).href;
            } catch (e) {
                return source;
            }
        };

        const isYuqueCardReady = (card) => {
            if (card.getAttribute("data-card-name") === "codeblock") {
                return !!card.querySelector(".cm-content");
            }
            const image = card.querySelector("img");
            return !!image && "" !== getImageSource(image);
        };

        const waitForYuqueCard = (card, timeout = 2000) => {
            if (isYuqueCardReady(card)) {
                return Promise.resolve(true);
            }
            return new Promise((resolve) => {
                let completed = false;
                const complete = (ready) => {
                    if (completed) {
                        return;
                    }
                    completed = true;
                    observer.disconnect();
                    clearTimeout(timer);
                    resolve(ready);
                };
                const observer = new MutationObserver(() => {
                    if (isYuqueCardReady(card)) {
                        complete(true);
                    }
                });
                const timer = setTimeout(() => complete(isYuqueCardReady(card)), timeout);
                observer.observe(card, {
                    attributes: true,
                    attributeFilter: ["src", "data-src", "data-original", "data-origin-src", "data-lazy-src"],
                    childList: true,
                    subtree: true,
                });
                card.scrollIntoView({behavior: "auto", block: "center", inline: "nearest"});
            });
        };

        const prepareYuqueCards = async (doc) => {
            if (!isYuquePage()) {
                return;
            }
            const cards = Array.from(doc.querySelectorAll(
                'ne-card[data-card-name="image"], ne-card[data-card-name="codeblock"]'
            ));
            const scrollX = window.scrollX;
            const scrollY = window.scrollY;
            try {
                for (const card of cards) {
                    await waitForYuqueCard(card);
                }
            } finally {
                window.scrollTo(scrollX, scrollY);
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }
        };

        const prepareYuqueImages = (sourceDoc, clonedDoc) => {
            if (!isYuquePage()) {
                return [];
            }
            const selector = ".yuque-doc-content img";
            const sourceImages = Array.from(sourceDoc.querySelectorAll(selector));
            const clonedImages = Array.from(clonedDoc.querySelectorAll(selector));
            return sourceImages.map((sourceImage, index) => {
                const src = getImageSource(sourceImage);
                const clonedImage = clonedImages[index];
                if (clonedImage) {
                    clonedImage.setAttribute(SIYUAN_CLIP_IMAGE_INDEX_ATTR, index.toString());
                    if (src) {
                        clonedImage.setAttribute("src", src);
                    }
                }
                return {
                    src,
                    alt: sourceImage.getAttribute("alt") || "",
                };
            });
        };

        const normalizeYuqueCodeBlocks = (doc) => {
            if (!isYuquePage()) {
                return;
            }
            doc.querySelectorAll('ne-card[data-card-name="codeblock"]').forEach((card) => {
                const content = card.querySelector(".cm-content");
                if (!content) {
                    return;
                }
                const lines = Array.from(content.querySelectorAll(".cm-line"));
                const codeText = 0 < lines.length
                    ? lines.map((line) => line.textContent).join("\n")
                    : content.textContent;
                const pre = doc.createElement("pre");
                const code = doc.createElement("code");
                code.textContent = codeText;
                pre.appendChild(code);
                card.replaceWith(pre);
            });
        };

        const restoreYuqueImages = (root, imageSources) => {
            if (!isYuquePage() || 0 === imageSources.length) {
                return;
            }
            const sourcesByAlt = new Map();
            imageSources.forEach((source, index) => {
                if (!source.src || !source.alt) {
                    return;
                }
                const sources = sourcesByAlt.get(source.alt) || [];
                sources.push({index, src: source.src});
                sourcesByAlt.set(source.alt, sources);
            });
            const usedSourceIndexes = new Set();
            root.querySelectorAll("img").forEach((image) => {
                if (getImageSource(image)) {
                    image.removeAttribute(SIYUAN_CLIP_IMAGE_INDEX_ATTR);
                    return;
                }
                const sourceIndex = Number.parseInt(image.getAttribute(SIYUAN_CLIP_IMAGE_INDEX_ATTR), 10);
                let source = Number.isInteger(sourceIndex) ? imageSources[sourceIndex] : undefined;
                if (!source?.src) {
                    const altSources = sourcesByAlt.get(image.getAttribute("alt") || "") || [];
                    const altSource = altSources.find((item) => !usedSourceIndexes.has(item.index));
                    if (altSource) {
                        source = altSource;
                        usedSourceIndexes.add(altSource.index);
                    }
                } else {
                    usedSourceIndexes.add(sourceIndex);
                }
                if (source?.src) {
                    image.setAttribute("src", source.src);
                }
                image.removeAttribute(SIYUAN_CLIP_IMAGE_INDEX_ATTR);
            });
        };

        // 网页换行用 span 样式 word-break 的特殊处理（与官方扩展一致）
        function isIgnoredElement(element) {
            while (element) {
                let tagName = element.tagName.toLowerCase();
                const className = String(element.className || "").toLowerCase();
                if (
                    tagName === "math" ||
                    className.includes("math") ||
                    className.includes("mathjax") ||
                    className.includes("latex") ||
                    className.includes("katex") ||
                    className.includes("mjx") ||
                    className.includes("mathml") ||
                    className.includes("equation") ||
                    className.includes("formula")
                ) {
                    return true;
                }
                element = element.parentElement;
                if (!element) {
                    break;
                }
                tagName = element.tagName.toLowerCase();
                if (["pre", "code", "span", "section"].includes(tagName)) {
                    return true;
                } else if (["div", "p"].includes(tagName)) {
                    return false;
                }
            }
            return false;
        }

        function processTextByWhiteSpace(element) {
            const text = element.textContent;
            const whiteSpace = getComputedStyle(element).whiteSpace;
            const brTag = "<br>";
            switch (whiteSpace) {
                case "normal":
                case "nowrap":
                    return text
                        .replace(/[ \t\r\f\v]+/g, " ")
                        .replace(/[ \t]+\n/g, "\n")
                        .replace(/\n+/g, brTag)
                        .trim();
                case "pre":
                    return text.replace(/\n/g, brTag);
                case "pre-wrap":
                    return text.replace(/\n+/g, brTag);
                case "pre-line":
                    return text
                        .replace(/[ \t\r\f\v]+/g, " ")
                        .replace(/[ \t]+\n/g, "\n")
                        .replace(/\n+/g, brTag)
                        .trim();
                case "break-spaces":
                    return text.replace(/\n/g, brTag);
                default:
                    return text
                        .replace(/[ \t\r\f\v]+/g, " ")
                        .replace(/[ \t]+\n/g, "\n")
                        .replace(/\n+/g, brTag)
                        .trim();
            }
        }

        function spansAddBr(tempElement) {
            const spans = tempElement.querySelectorAll("span");
            if (!spans || spans.length === 0) {
                return;
            }
            spans.forEach((span) => {
                const style = window.getComputedStyle(span);
                if (
                    (style.whiteSpace.trim().toLowerCase() === "normal" ||
                        style.whiteSpace.trim().toLowerCase() === "pre-wrap") &&
                    (style.wordWrap.trim().toLowerCase() === "break-word" ||
                        style.overflowWrap.trim().toLowerCase() === "break-word" ||
                        style.wordBreak.trim().toLowerCase() === "break-word")
                ) {
                    if (isIgnoredElement(span)) {
                        return;
                    }
                    span.innerHTML = processTextByWhiteSpace(span);
                }
            });
        }

        function parentContainsBold(element) {
            let parent = element.parentElement;
            while (parent) {
                if (["B", "STRONG", "H1", "H2", "H3", "H4", "H5", "H6"].includes(parent.tagName)) {
                    return true;
                }
                parent = parent.parentElement;
            }
            return false;
        }

        function processBoldStyle(tempElement) {
            const boldElements = tempElement.querySelectorAll("*");
            boldElements.forEach((element) => {
                if (["B", "STRONG"].includes(element.tagName)) {
                    return;
                }
                if (parentContainsBold(element)) {
                    return;
                }
                const style = window.getComputedStyle(element);
                if (style.fontWeight === "bold" || style.fontWeight === "700") {
                    const children = element.childNodes;
                    for (let i = 0; i < children.length; i++) {
                        const child = children[i];
                        if (child.nodeType === Node.TEXT_NODE) {
                            const textElement = document.createElement("b");
                            textElement.textContent = child.nodeValue;
                            element.replaceChild(textElement, child);
                        } else if (child.nodeType === Node.ELEMENT_NODE) {
                            const childTagName = child.tagName.toLowerCase();
                            if (["b", "strong"].includes(childTagName)) {
                                continue;
                            }
                            if (parentContainsBold(child)) {
                                continue;
                            }
                            processBoldStyle(child);
                        }
                    }
                }
            });
        }

        function parentContainsItalic(element) {
            let parent = element.parentElement;
            while (parent) {
                if (["I", "EM"].includes(parent.tagName)) {
                    return true;
                }
                parent = parent.parentElement;
            }
            return false;
        }

        function processItalicStyle(tempElement) {
            const allElements = tempElement.querySelectorAll("*");
            allElements.forEach((element) => {
                if (["I", "EM"].includes(element.tagName)) {
                    return;
                }
                if (parentContainsItalic(element)) {
                    return;
                }
                const style = window.getComputedStyle(element);
                if (style.fontStyle === "italic") {
                    const children = element.childNodes;
                    for (let i = 0; i < children.length; i++) {
                        const child = children[i];
                        if (child.nodeType === Node.TEXT_NODE) {
                            const textElement = document.createElement("i");
                            textElement.textContent = child.nodeValue;
                            element.replaceChild(textElement, child);
                        } else if (child.nodeType === Node.ELEMENT_NODE) {
                            const childTagName = child.tagName.toLowerCase();
                            if (["i", "em"].includes(childTagName)) {
                                continue;
                            }
                            if (parentContainsItalic(child)) {
                                continue;
                            }
                            processItalicStyle(child);
                        }
                    }
                }
            });
        }

        function parentContainsUnderline(element) {
            let parent = element.parentElement;
            while (parent) {
                if (parent.tagName === "U") {
                    return true;
                }
                parent = parent.parentElement;
            }
            return false;
        }

        function processUnderlineStyle(tempElement) {
            const allElements = tempElement.querySelectorAll("*");
            allElements.forEach((element) => {
                if (element.tagName === "U") {
                    return;
                }
                if (parentContainsUnderline(element)) {
                    return;
                }
                const style = window.getComputedStyle(element);
                if (style.textDecorationLine.includes("underline")) {
                    const children = element.childNodes;
                    for (let i = 0; i < children.length; i++) {
                        const child = children[i];
                        if (child.nodeType === Node.TEXT_NODE) {
                            const textElement = document.createElement("u");
                            textElement.textContent = child.nodeValue;
                            element.replaceChild(textElement, child);
                        } else if (child.nodeType === Node.ELEMENT_NODE) {
                            const childTagName = child.tagName.toLowerCase();
                            if (childTagName === "u") {
                                continue;
                            }
                            if (parentContainsUnderline(child)) {
                                continue;
                            }
                            processUnderlineStyle(child);
                        }
                    }
                }
            });
        }

        const FORMULA_SELECTOR = "[data-formula]";

        function simplifyNestedTags(root, tagName) {
            let elements = root.querySelectorAll(tagName);
            let hasNested = true;
            while (hasNested) {
                hasNested = false;
                elements.forEach((element) => {
                    if (!element.closest(FORMULA_SELECTOR) && simplifyElement(element, tagName)) {
                        hasNested = true;
                    }
                });
                elements = root.querySelectorAll(tagName);
            }
            function simplifyElement(element, tagName) {
                let nestedFound = false;
                Array.from(element.children).forEach((child) => {
                    if (child.matches(FORMULA_SELECTOR)) {
                        return;
                    }
                    if (child.tagName === tagName) {
                        nestedFound = true;
                        while (child.firstChild) {
                            element.insertBefore(child.firstChild, child);
                        }
                        child.remove();
                    } else {
                        nestedFound = simplifyElement(child, tagName) || nestedFound;
                    }
                });
                return nestedFound;
            }
        }

        function removeImgLink(tempElement) {
            const images = tempElement.querySelectorAll("img");
            images.forEach((image) => {
                const parent = image.parentElement;
                if (!parent) {
                    return;
                }
                if (parent.tagName === "A") {
                    const grandParent = parent.parentElement;
                    if (!grandParent) {
                        return;
                    }
                    grandParent.insertBefore(image, parent);
                    parent.remove();
                }
            });
        }

        async function svgToBase64(svgNode) {
            const serializer = new XMLSerializer();
            let svgStr = serializer.serializeToString(svgNode);
            if (!svgStr.startsWith("<?xml")) {
                svgStr = '<?xml version="1.0" encoding="UTF-8"?>' + svgStr;
            }
            const svgBlob = new Blob([svgStr], {type: "image/svg+xml"});
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(svgBlob);
            });
            return dataUrl;
        }

        async function svgToImg(tempElement) {
            const svgElements = tempElement.querySelectorAll("svg");
            for (const svg of svgElements) {
                const img = document.createElement("img");
                img.src = await svgToBase64(svg);
                img.style.cssText = window.getComputedStyle(svg).cssText;
                svg.parentNode.replaceChild(img, svg);
            }
        }

        function adaptMSN(tempDoc) {
            if (tempDoc.documentURI.indexOf("msn.cn") !== -1) {
                const articles = tempDoc.querySelectorAll(".consumption-page-gridarea_content");
                articles.forEach((article) => {
                    const shadowHost = article.querySelector("views-header-wc");
                    if (!shadowHost || !shadowHost.shadowRoot) {
                        return;
                    }
                    const titleEle = shadowHost.shadowRoot.querySelector("h1");
                    if (!titleEle) {
                        return;
                    }
                    if (titleEle.innerText.indexOf(tempDoc.title) === -1) {
                        article.remove();
                    }
                });
                const shadowHosts = tempDoc.querySelectorAll("cp-article");
                shadowHosts.forEach((element) => {
                    const shadowRoot = element.shadowRoot;
                    if (!shadowRoot) {
                        return;
                    }
                    const slots = shadowRoot.querySelectorAll("slot");
                    slots.forEach((slot) => {
                        const slotName = slot.getAttribute("name");
                        element.querySelectorAll(`[slot="${slotName}"]`).forEach((slotElement) => {
                            const imgEle = slotElement.querySelector("cp-article-image");
                            if (!imgEle || !imgEle.shadowRoot) {
                                return;
                            }
                            const imgs = imgEle.shadowRoot.querySelectorAll("img");
                            if (!imgs || imgs.length === 0) {
                                return;
                            }
                            slotElement.innerHTML = "";
                            imgs.forEach((img) => {
                                slotElement.appendChild(img.cloneNode(true));
                            });
                            slot.innerHTML = slotElement.innerHTML;
                        });
                    });
                    const shadowContent = shadowRoot.innerHTML;
                    const newDiv = tempDoc.createElement("div");
                    newDiv.innerHTML = shadowContent;
                    element.parentNode.replaceChild(newDiv, element);
                });
            }
        }

        function fixInvalidNesting(doc) {
            const inlineTags = ["span", "strong", "b", "i", "em", "a"];
            const blockTags = [
                "div", "p", "h1", "h2", "h3", "h4", "h5", "h6",
                "ul", "ol", "li", "table", "tr", "td", "th",
                "blockquote", "section", "article",
            ];
            const ownerDocument = doc.ownerDocument || doc;
            const inlineSelector = inlineTags.join(",");
            const blockSelector = blockTags.join(",");

            const invalidHeadings = Array.from(doc.querySelectorAll("h1, h2, h3, h4, h5, h6"))
                .filter((heading) => heading.querySelector(blockSelector));
            invalidHeadings.forEach((heading) => {
                const firstBlock = heading.querySelector(blockSelector);
                if (!firstBlock || !heading.parentNode) {
                    return;
                }
                const range = ownerDocument.createRange();
                range.selectNodeContents(heading);
                range.setEndBefore(firstBlock);
                const normalizedHeading = heading.cloneNode(false);
                normalizedHeading.appendChild(range.extractContents());
                const trailingContent = ownerDocument.createDocumentFragment();
                while (heading.firstChild) {
                    trailingContent.appendChild(heading.firstChild);
                }
                const parent = heading.parentNode;
                parent.insertBefore(normalizedHeading, heading);
                parent.insertBefore(trailingContent, heading);
                heading.remove();
            });

            const allInlines = Array.from(doc.querySelectorAll(inlineSelector));
            const targets = allInlines.filter((el) => el.querySelector(blockSelector)).reverse();
            targets.forEach((oldEl) => {
                if (!oldEl.parentNode) return;
                const newDiv = ownerDocument.createElement("div");
                for (const attr of oldEl.attributes) {
                    newDiv.setAttribute(attr.name, attr.value);
                }
                while (oldEl.firstChild) {
                    newDiv.appendChild(oldEl.firstChild);
                }
                oldEl.parentNode.replaceChild(newDiv, oldEl);
            });
        }

        // MathJax 公式标记（内联版，不依赖扩展脚本加载）
        const markMathJaxFormulas = () => {
            try {
                if (window.MathJax?.startup) {
                    MathJax.startup.document.getMathItemsWithin(document.body)
                        .forEach(item => item.typesetRoot?.setAttribute('data-formula', item.math));
                } else if (window.MathJax?.Hub) {
                    window.MathJax.Hub.getAllJax()
                        .forEach(math => {
                            const originalTex = math.originalText;
                            const scriptTag = math.SourceElement();
                            const displayElement = scriptTag ? scriptTag.previousSibling : null;
                            if (displayElement && displayElement.setAttribute) {
                                displayElement.setAttribute('data-formula', originalTex);
                            }
                        });
                }
            } catch (e) {
                console.warn("[sy-browser-clip] MathJax mark failed:", e);
            }
        };

        const resolvePictureImageURL = (value, sourceURL) => {
            if (!value?.trim()) {
                return "";
            }
            try {
                const url = sourceURL ? new URL(value, sourceURL) : new URL(value);
                return /^https?:$/.test(url.protocol) ? url.href : "";
            } catch (_error) {
                return "";
            }
        };

        const getPictureImageSource = (srcset, sourceURL) => {
            let remaining = srcset;
            let selected = "";
            let selectedSize = 0;
            while (remaining) {
                remaining = remaining.replace(/^[\s,]+/, "");
                const token = remaining.match(/^\S+/)?.[0];
                if (!token) {
                    break;
                }
                remaining = remaining.substring(token.length);
                let source = token;
                let descriptor = "";
                if (source.endsWith(",")) {
                    source = source.replace(/,+$/, "");
                } else {
                    const end = remaining.indexOf(",");
                    descriptor = (end < 0 ? remaining : remaining.substring(0, end)).trim();
                    remaining = end < 0 ? "" : remaining.substring(end + 1);
                }
                if (descriptor && !/^(?:[1-9]\d*w|(?:\d+(?:\.\d+)?|\.\d+)x)$/.test(descriptor)) {
                    continue;
                }
                const size = descriptor ? Number.parseFloat(descriptor) : 1;
                const url = resolvePictureImageURL(source, sourceURL);
                if (url && Number.isFinite(size) && size > selectedSize) {
                    selected = url;
                    selectedSize = size;
                }
            }
            return selected;
        };

        const normalizePictureImages = (root, sourceURL, sourceImages) => {
            root.querySelectorAll("img").forEach((image, index) => {
                const original = sourceImages?.[index] || image;
                const picture = original.closest("picture");
                if (!picture) {
                    return;
                }
                let source = resolvePictureImageURL(original.currentSrc, sourceURL);
                const src = image.getAttribute("src")?.trim() || "";
                if (!source && src && !/^data:image\//i.test(src)) {
                    return;
                }
                if (!source) {
                    for (const element of Array.from(picture.children)) {
                        if (element.tagName !== "SOURCE") {
                            continue;
                        }
                        const type = element.getAttribute("type")?.trim().toLowerCase();
                        if (type && !/^image\/(?:avif|webp|png|jpeg|gif|svg\+xml)$/.test(type)) {
                            continue;
                        }
                        const media = element.getAttribute("media");
                        if (media && !window.matchMedia(media).matches) {
                            continue;
                        }
                        source = getPictureImageSource(element.getAttribute("srcset") ||
                            element.getAttribute("data-srcset") || "", sourceURL);
                        if (source) {
                            break;
                        }
                    }
                }
                source = source || getPictureImageSource(original.getAttribute("srcset") ||
                    original.getAttribute("data-srcset") || "", sourceURL);
                if (source) {
                    image.setAttribute("src", source);
                    ["srcset", "data-src", "data-srcset", "data-original", "data-origin-src", "data-lazy-src"].forEach(attribute =>
                        image.removeAttribute(attribute));
                }
            });
        };

        // Readability 前处理：在克隆文档上执行样式类替换（与官方扩展一致）
        const getCloneNode = async (tempDoc) => {
            adaptMSN(tempDoc);
            if (exp.bold) {
                processBoldStyle(tempDoc);
            }
            if (exp.italic) {
                processItalicStyle(tempDoc);
            }
            if (exp.underline) {
                processUnderlineStyle(tempDoc);
            }
            if (exp.removeImgLink) {
                removeImgLink(tempDoc);
            }
            if (exp.span) {
                spansAddBr(tempDoc);
            }
            if (exp.svgToImg) {
                await svgToImg(tempDoc);
            }
            simplifyNestedTags(tempDoc, "STRONG");
            simplifyNestedTags(tempDoc, "B");
            simplifyNestedTags(tempDoc, "I");
            simplifyNestedTags(tempDoc, "EM");

            const mathElements = tempDoc.querySelectorAll(".ztext-math");
            mathElements.forEach((mathElement) => {
                const mathParent = mathElement.parentElement;
                if (mathParent && ["B", "STRONG", "I", "EM"].includes(mathParent.tagName)) {
                    const parent = mathParent;
                    while (parent.firstChild) {
                        parent.parentNode.insertBefore(parent.firstChild, parent);
                    }
                    parent.remove();
                }
            });

            fixInvalidNesting(tempDoc);

            const clonedDoc = document.cloneNode(true);
            normalizePictureImages(clonedDoc, document.baseURI, Array.from(document.querySelectorAll("img")));
            return clonedDoc;
        };

        // === 主流程 ===
        markMathJaxFormulas();
        document.querySelectorAll(".hljs-comment").forEach((item) => {
            item.classList.remove("hljs-comment");
            item.classList.add("hljs-cmt");
        });

        let tempElement = document.createElement("div");
        let article = null;

        if (mode === "part") {
            // 选区剪藏
            const selection = window.getSelection();
            if (!selection || 0 === selection.rangeCount) {
                result.error = "no_selection";
                return JSON.stringify(result);
            }
            const range = selection.getRangeAt(0);
            tempElement.appendChild(range.cloneContents());
            const sourceImages = Array.from(document.querySelectorAll("img")).filter(image => range.intersectsNode(image));
            normalizePictureImages(tempElement, document.baseURI, sourceImages);
        } else {
            // 整页剪藏：Yuque 适配 + 前处理 + Readability
            await prepareYuqueCards(document);
            const clonedDoc = await getCloneNode(document);
            const yuqueImageSources = prepareYuqueImages(document, clonedDoc);
            normalizeYuqueCodeBlocks(clonedDoc);

            article = new Readability(clonedDoc, {
                keepClasses: true,
                charThreshold: 16,
                debug: true,
            }).parse();
            if (!article?.content) {
                result.error = "readability_failed";
                return JSON.stringify(result);
            }
            tempElement.innerHTML = article.content;
            restoreYuqueImages(tempElement, yuqueImageSources);
            simplifyNestedTags(tempElement, "DIV");
            simplifyNestedTags(tempElement, "SPAN");
            simplifyNestedTags(tempElement, "SECTION");
            simplifyNestedTags(tempElement, "ARTICLE");
            simplifyNestedTags(tempElement, "P");
        }

        // 收集图片（与官方扩展 siyuanSendUpload 一致）
        normalizePictureImages(tempElement, document.baseURI);
        let srcList = [];
        const images = tempElement.querySelectorAll("img");
        images.forEach((item) => {
            let src = item.getAttribute("src");
            if (!src) {
                return;
            }
            const itemClassName = String(item.className || "");
            if (itemClassName.includes("emoji") && "" !== item.getAttribute("alt")) {
                return;
            }
            let dataOriginal = item.getAttribute("data-original");
            if (dataOriginal && !dataOriginal.startsWith("/")) {
                if (!src || !src.endsWith(".gif")) {
                    src = dataOriginal;
                }
            }
            if ("https:" === window.location.protocol) {
                if (src.startsWith("http:")) {
                    src = src.replace("http:", "https:");
                } else if (src.startsWith("//")) {
                    src = "https:" + src;
                }
                item.setAttribute("src", src);
            }
            if (-1 < itemClassName.indexOf("ztext-gif") && -1 < src.indexOf("zhimg.com")) {
                src = src.replace(".jpg", ".webp");
            }
            srcList.push(src);
        });
        srcList = [...new Set(srcList)];
        if (!config.assets) {
            srcList = [];
        }

        const files = {};
        let filesSize = 0;
        for (let i = 0; i < srcList.length; i++) {
            let src = srcList[i];
            try {
                // Wikipedia 使用图片原图
                if (-1 !== src.indexOf("wikipedia/commons/thumb/")) {
                    let idx = src.lastIndexOf(".");
                    let ext = src.substring(idx);
                    if (0 < src.indexOf(".svg.png")) {
                        ext = ".svg";
                    }
                    idx = src.indexOf(ext + "/");
                    if (0 < idx) {
                        src = src.substring(0, idx + ext.length);
                        src = src.replace("/commons/thumb/", "/commons/");
                    }
                }
                const response = await fetch(src, {
                    headers: {
                        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                        "sec-fetch-dest": "image",
                    },
                });
                if (!response.ok) {
                    result.fetchFileErr = true;
                    continue;
                }
                const image = await response.blob();
                const data = await convertBlobToBase64(image);
                files[escape(src)] = { type: image.type, data: data };
                filesSize += data.length;
                if (1000 * 1000 * 60 < filesSize) {
                    result.fetchFileErr = true;
                    for (const k of Object.keys(files)) { delete files[k]; }
                    break;
                }
            } catch (e) {
                console.warn("[sy-browser-clip] fetch [" + src + "] failed", e);
                result.fetchFileErr = true;
            }
        }

        result.ok = true;
        result.dom = tempElement.innerHTML;
        result.files = files;
        result.title = article && article.title ? article.title : document.title || "";
        result.siteName = article && article.siteName ? article.siteName : "";
        result.excerpt = article && article.excerpt ? article.excerpt : "";
        return JSON.stringify(result);
    } catch (e) {
        result.error = String(e && e.message || e);
        return JSON.stringify(result);
    }
})();
