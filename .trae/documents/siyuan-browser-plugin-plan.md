# 思源浏览器插件开发计划

## 一、Summary（概要）

基于思源笔记（SiYuan）插件系统，开发一个**具备完整浏览器功能的插件**。核心渲染引擎使用 Electron `<webview>` 标签（思源桌面端 `webPreferences` 已启用 `webviewTag: true, nodeIntegration: true, webSecurity: false`），可加载任意网站（不受 X-Frame-Options/CSP 限制），配合思源插件的页签/Dock/顶栏/命令/菜单扩展点，实现多页签、地址栏、书签、历史、下载、设置等全部浏览器功能。

**仅支持桌面端**（Electron 环境），移动端/浏览器访问端不可用（webview 标签是 Electron 专有）。

---

## 二、Current State Analysis（现状分析）

- 工作目录 `e:\HOME\Code\新建文件夹` 为**空目录**，从零开始搭建。
- 通过调研确认：
  - 思源插件 API 仓库：`siyuan-note/petal`，npm 包名 `siyuan`（当前 1.2.2）
  - 官方模板：`siyuan-note/plugin-sample`（webpack + esbuild-loader）
  - 桌面端 `app/electron/main.js` 主窗口 `webPreferences` 已启用 `webviewTag: true`
  - `openWindow()` API 仅支持 `doc: { id }`（思源文档块），不支持任意 URL — 因此浏览器渲染**必须**在自定义页签内手动创建 `<webview>` DOM 元素
  - 内核插件（kernel.ts）可选：用于绕过 CORS 抓取页面元数据、下载文件到 `data/assets/`、持久化大文件
  - 数据持久化规范：插件自己的数据用 `Plugin.saveData()` / `Plugin.loadData()`（存 `data/storage/petal/<plugin>/`）；下载到思源资源库用 `/api/file/putFile` 或 `/api/asset/upload`

---

## 三、Proposed Changes（计划变更）

### 3.1 项目骨架

**目录结构**（参考 plugin-sample，webpack 双配置：前端 + 内核）：

```
siyuan-plugin-browser/
├── plugin.json                  # 插件元数据
├── package.json                 # 依赖与构建脚本
├── tsconfig.json
├── webpack.config.js            # 前端打包（index.js）
├── webpack.kernel.config.js     # 内核打包（kernel.js，ESM）
├── icon.png                     # 160×160 插件图标
├── preview.png                  # 1024×768 预览图
├── README.md / README.zh-CN.md
├── src/
│   ├── index.ts                 # 前端插件入口（extends Plugin）
│   ├── kernel.ts                # 内核插件入口（网络/下载/存储）
│   ├── index.scss               # 样式
│   ├── i18n/
│   │   ├── en_US.json
│   │   └── zh_CN.json
│   ├── types.ts                 # 内部类型（书签/历史/下载/页签状态）
│   ├── constants.ts             # 常量（默认主页、搜索引擎、storage key）
│   ├── browser/
│   │   ├── BrowserTab.ts        # 浏览器页签模型（封装 <webview> 与工具栏）
│   │   ├── Toolbar.ts           # 工具栏（前进/后退/刷新/地址栏/菜单按钮）
│   │   ├── WebviewController.ts # webview 事件路由与状态同步
│   │   └── contextMenu.ts       # 右键菜单（复制/粘贴/检查元素/另存为等）
│   ├── docks/
│   │   ├── BookmarksDock.ts     # 书签栏 Dock
│   │   ├── HistoryDock.ts       # 历史记录 Dock
│   │   └── DownloadsDock.ts     # 下载管理 Dock
│   ├── storage/
│   │   ├── bookmarksStore.ts    # 书签 CRUD（Plugin.saveData）
│   │   ├── historyStore.ts      # 历史 CRUD（带去重/上限）
│   │   ├── downloadsStore.ts    # 下载元数据持久化
│   │   └── settingsStore.ts     # 设置项（主页/搜索引擎/隐私）
│   ├── commands/
│   │   └── shortcuts.ts         # 快捷键注册（Ctrl+T/W/L/R/F 等）
│   ├── settings/
│   │   └── SettingsDialog.ts    # 设置对话框（基于 Dialog）
│   └── utils/
│       ├── url.ts               # URL 规范化（自动补协议、搜索词转 URL）
│       ├── favicon.ts           # 站点图标获取（Google s2 favicon 服务 + 内核兜底）
│       └── dom.ts               # DOM 工具
└── .gitignore
```

### 3.2 plugin.json（必填字段）

```json
{
  "name": "siyuan-plugin-browser",
  "author": "your-name",
  "url": "https://github.com/your-name/siyuan-plugin-browser",
  "version": "0.1.0",
  "minAppVersion": "3.7.0",
  "backends": ["all"],
  "frontends": ["desktop", "desktop-window"],
  "kernels": ["all"],
  "disabledInPublish": true,
  "displayName": { "default": "Browser", "zh-CN": "浏览器" },
  "description": {
    "default": "A full-featured browser inside SiYuan, powered by Electron <webview>.",
    "zh-CN": "思源内置浏览器，基于 Electron <webview>，支持多页签、书签、历史、下载。"
  },
  "readme": { "default": "README.md", "zh-CN": "README.zh-CN.md" },
  "keywords": ["browser", "webview", "浏览器"]
}
```

**关键决策**：
- `frontends: ["desktop", "desktop-window"]` — webview 仅桌面端可用
- `kernels: ["all"]` — 启用内核插件以支持下载/抓取
- `disabledInPublish: true` — 发布服务下禁用

### 3.3 package.json 与构建

- 依赖：`siyuan@1.2.2`（API 类型）、`webpack@5` + `webpack-cli` + `esbuild-loader`、`mini-css-extract-plugin`、`copy-webpack-plugin`、`zip-webpack-plugin`、`typescript`、`sass`、`npm-run-all`
- scripts：
  - `dev`: `run-p dev:kernel dev:app`
  - `build`: `run-s build:kernel build:app`（产出 `package.zip`）
- webpack 配置要点：
  - 前端：`externals: { siyuan: "siyuan" }`，`libraryTarget: "commonjs2"`
  - 内核：`experiments.outputModule: true`，`library.type: "module"`，ESM 输出
  - 生产构建用 ZipPlugin 生成 `package.zip`

### 3.4 前端插件入口 `src/index.ts`

```ts
export default class BrowserPlugin extends Plugin {
    onload() {
        // 1. 注册浏览器自定义页签类型
        this.addTab({ type: "browser-tab", init() {...}, destroy() {...}, ... });
        // 2. 注册三个 Dock（书签/历史/下载）
        this.addDock({ config: {...}, type: "browser-bookmarks", ... });
        this.addDock({ config: {...}, type: "browser-history", ... });
        this.addDock({ config: {...}, type: "browser-downloads", ... });
        // 3. 注册顶栏按钮（在 onLayoutReady 中）
        // 4. 注册快捷键命令
        this.addCommand({ langKey: "newTab", hotkey: "⌘T", callback: ... });
        // 5. 监听 eventBus：在链接右键菜单加入"在浏览器插件中打开"
        this.eventBus.on("open-menu-link", (e) => {
            e.detail.menu.addItem({ id, iconHTML, label, click: () => this.openUrl(url) });
        });
    }
    onLayoutReady() {
        this.addTopBar({ icon: "iconBrowser", title: "Open Browser", callback: () => this.openUrl(homepage) });
        // 加载持久化数据
    }
    openUrl(url: string) {
        openTab({ app: this.app, custom: { id: this.name + "browser-tab", icon: "iconBrowser", title: "Browser", data: { url } }, openNewTab: true });
    }
}
```

### 3.5 浏览器页签 `src/browser/BrowserTab.ts`（核心）

每个页签的 DOM 结构：

```html
<div class="sy-browser-tab">
  <div class="sy-browser-toolbar">
    <button data-act="back" title="后退">←</button>
    <button data-act="forward" title="前进">→</button>
    <button data-act="reload" title="刷新">⟳</button>
    <button data-act="home" title="主页">⌂</button>
    <input class="sy-browser-urlbar" placeholder="输入网址或搜索..." />
    <button data-act="bookmark" title="收藏">☆</button>
    <button data-act="menu" title="菜单">⋮</button>
  </div>
  <div class="sy-browser-content">
    <webview src="about:blank" preload="./preload.js" allowpopups></webview>
    <div class="sy-browser-loading"></div>
  </div>
</div>
```

`<webview>` 关键能力（基于 Electron API 文档核实）：
- 方法：`loadURL(url)` / `getURL()` / `getTitle()` / `goBack()` / `goForward()` / `reload()` / `reloadIgnoringCache()` / `executeJavaScript(code)` / `downloadURL(url)` / `findInPage(text)`
- 事件：`did-start-loading` / `did-stop-loading` / `did-finish-load` / `did-fail-load` / `did-navigate` / `did-navigate-in-page` / `page-title-updated` / `will-navigate` / `new-window` / `context-menu` / `page-favicon-updated` / `update-target-url` / `console-message`
- 属性：`src`、`preload`、`allowpopups`、`disablewebsecurity`、`useragent`

`WebviewController` 职责：
1. 同步地址栏：监听 `did-navigate` / `did-navigate-in-page` → 更新 `.urlbar.value = webview.getURL()`
2. 同步标题：监听 `page-title-updated` → 更新页签标题 `tab.updateTitle(title)`
3. 加载状态：监听 `did-start-loading` / `did-stop-loading` → 切换加载指示
4. 前进/后退按钮可用性：每个导航事件后检查 `webview.canGoBack()` / `canGoForward()`（通过历史栈自维护，因 webview 标签不直接暴露）
5. 历史记录：`did-navigate` 触发时写入 `historyStore`
6. favicon：监听 `page-favicon-updated`，回退到 `https://www.google.com/s2/favicons?domain=...`
7. `new-window` 事件：拦截 `window.open`/`target=_blank`，在新页签打开（调用 `plugin.openUrl(url)`）
8. `context-menu` 事件：自定义右键菜单（后退/前进/刷新/查看源代码/检查元素/复制链接/在新页签打开/另存为）
9. `will-navigate`：用户点击页内链接时同步地址栏

地址栏输入逻辑（`utils/url.ts`）：
- 含 `://` → 直接当 URL
- 形如 `example.com` → 补 `https://`
- 其他 → 用默认搜索引擎（设置项，默认 `https://www.google.com/search?q=`）拼装

### 3.6 书签 Dock `src/docks/BookmarksDock.ts`

- Dock 位置：`LeftBottom`，可拖到右侧
- 数据结构：
  ```ts
  interface Bookmark { id: string; title: string; url: string; favicon?: string; parentId: string | null; createdAt: number; }
  ```
- 持久化：`Plugin.saveData("bookmarks.json", ...)`，监听 `onDataChanged` 刷新 UI
- UI：树形列表（支持拖拽排序、嵌套文件夹），右键菜单（编辑/删除/在新页签打开）
- 工具栏按钮：添加书签、新建文件夹、导入 HTML（Netscape 格式）、导出 HTML
- 收藏按钮（工具栏的 ☆）：当前页 URL 已收藏则高亮，点击切换

### 3.7 历史 Dock `src/docks/HistoryDock.ts`

- Dock 位置：`RightTop`
- 数据结构：
  ```ts
  interface HistoryEntry { url: string; title: string; visitTime: number; favicon?: string; }
  ```
- 持久化：`Plugin.saveData("history.json", ...)`，上限 5000 条，超出 LRU 淘汰
- UI：按日期分组（今天/昨天/7 天内/更早），搜索框，每项右键（打开/删除/清空当天）
- 工具栏：清空全部历史、搜索

### 3.8 下载管理 Dock `src/docks/DownloadsDock.ts`

- Dock 位置：`BottomRight`
- 下载触发：
  1. webview `context-menu` 中"另存为"
  2. webview 内 `downloadURL(url)` 调用
  3. 用户点击下载链接 → `will-navigate` 检测 Content-Disposition（需内核代理探测 HEAD）
- 下载流程（通过内核插件 RPC）：
  1. 前端 `kernel.rpc.call.download({ url, suggestedName })`
  2. 内核用 `siyuan.client.fetch("/api/network/forwardProxy", {...})` 抓取二进制 → `siyuan.storage.put("downloads/<name>", buffer)`，或调用 `/api/asset/upload` 写入思源 `data/assets/`
  3. 内核通过 `siyuan.rpc.broadcast("download-progress", { id, received, total })` 推送进度
  4. 前端监听进度更新 UI
- 数据结构：
  ```ts
  interface DownloadItem { id: string; url: string; filename: string; savePath: string; total: number; received: number; state: "in_progress"|"completed"|"canceled"|"interrupted"; startedAt: number; }
  ```
- UI：列表（文件名/大小/进度条/状态/操作），右键（打开文件/在文件夹中显示/重新下载/删除/复制链接）
- 工具栏：清空已完成、暂停全部、继续全部

### 3.9 设置 `src/settings/SettingsDialog.ts`

- 基于 `Dialog`，宽 `640px`
- 设置项：
  - 主页 URL（默认 `https://www.bing.com`）
  - 默认搜索引擎（Google/Bing/Baidu/自定义）
  - 下载保存位置：思源 assets / 插件 storage / 系统下载目录（仅元数据）
  - 历史上限（默认 5000）
  - 是否启用 webview `preload` 注入（用于页面内 JS 互通）
  - User-Agent 覆盖（可选）
  - 代理设置（透传到内核 `forwardProxy`）
- 持久化：`Plugin.saveData("settings.json", ...)`

### 3.10 快捷键 `src/commands/shortcuts.ts`

| 功能 | 快捷键（Mac） | 快捷键（Win/Linux） |
|---|---|---|
| 新建页签 | ⌘T | Ctrl+T |
| 关闭当前页签 | ⌘W | Ctrl+W |
| 聚焦地址栏 | ⌘L | Ctrl+L |
| 刷新 | ⌘R | Ctrl+R |
| 强制刷新 | ⇧⌘R | Shift+Ctrl+R |
| 后退 | ⌘[ | Alt+← |
| 前进 | ⌘] | Alt+→ |
| 在页内查找 | ⌘F | Ctrl+F |
| 打开书签 Dock | ⌥⌘B | Alt+Ctrl+B |
| 打开历史 Dock | ⌥⌘Y | Alt+Ctrl+Y |
| 打开下载 Dock | ⌥⌘J | Alt+Ctrl+J |

通过 `this.addCommand({ langKey, hotkey, callback })` 注册，回调中通过 `getActiveTab()` 获取当前浏览器页签并调用对应方法。

### 3.11 内核插件 `src/kernel.ts`

```ts
class BrowserKernel {
    constructor() {
        this.siyuan.plugin.lifecycle.onload = this.onload.bind(this);
    }
    onload() {
        // 下载文件到 storage 或 assets
        this.siyuan.rpc.bind("download", async (url, suggestedName, target) => {
            const resp = await this.siyuan.client.fetch("/api/network/forwardProxy", {
                method: "POST",
                body: JSON.stringify({ url, method: "GET" }),
            });
            const buf = await resp.buffer();
            if (target === "assets") {
                // 调用 /api/asset/upload 写入思源资源库
            } else {
                await this.siyuan.storage.put(`downloads/${suggestedName}`, buf);
            }
            return { path: ... };
        }, "下载文件到思源");

        // 抓取页面元数据（标题/描述/favicon）
        this.siyuan.rpc.bind("fetchMeta", async (url) => {
            const resp = await this.siyuan.client.fetch("/api/network/forwardProxy", {
                method: "POST", body: JSON.stringify({ url, method: "GET" }),
            });
            const html = await resp.text();
            return parseMeta(html); // 简单正则提取 <title>/<meta>
        }, "抓取页面元信息");

        // HTTP HEAD 探测（用于判断链接是页面还是文件下载）
        this.siyuan.rpc.bind("head", async (url) => {
            const resp = await this.siyuan.client.fetch("/api/network/forwardProxy", {
                method: "POST", body: JSON.stringify({ url, method: "HEAD" }),
            });
            return { status: resp.status, headers: resp.headers };
        }, "HTTP HEAD 探测");
    }
}
```

前端调用：`const result = await this.kernel.rpc.call.download(url, name, "assets");`

### 3.12 i18n

`zh_CN.json` / `en_US.json`，键包括：`newTab`、`closeTab`、`back`、`forward`、`reload`、`addressBar`、`bookmarks`、`history`、`downloads`、`settings`、`addBookmark`、`removeBookmark`、`clearHistory`、`openInNewTab`、`viewSource`、`inspect`、`saveAs`、`copyLink`、`findInPage`、`home`、`searchEngine` 等。

### 3.13 样式 `src/index.scss`

- 工具栏高度 36px，按钮 28×28，地址栏占满剩余空间
- webview 填充剩余区域（`flex: 1`）
- 加载进度条：顶部 2px 蓝条动画
- Dock 列表项 hover/active 状态
- 暗色主题适配（思源 CSS 变量 `--b3-theme-*`）

---

## 四、Assumptions & Decisions（假设与决策）

1. **仅桌面端**：webview 标签是 Electron 专有，`frontends` 限制为 `desktop, desktop-window`。
2. **渲染核心**：使用 Electron `<webview>` 标签（思源已启用 `webviewTag: true`），可加载任意网站，不依赖 iframe/forwardProxy 作为主渲染方式。
3. **内核插件启用**：用于下载（绕过 CORS 抓二进制）、HEAD 探测、元数据抓取。前端 ↔ 内核通过 JSON-RPC 通信。
4. **数据持久化分工**：
   - 书签/历史/设置 → `Plugin.saveData()`（存 `data/storage/petal/<plugin>/`）
   - 下载文件 → 优先思源 `data/assets/`（用 `/api/asset/upload`），其次插件 storage
5. **多页签管理**：每个浏览器页签是一个独立的 SiYuan 自定义页签（type=`browser-tab`），由 SiYuan 原生页签系统管理（关闭/拖拽/拆分窗口），无需自建页签条。
6. **下载不调用 Electron 原生 `DownloadItem`**：webview 标签的 `downloadURL` 在思源沙箱内可能受限，改用内核 `forwardProxy` 拉取 → `storage.put` / `/api/asset/upload`。
7. **隐私模式不实现**：避免过度设计，统一记录历史（设置中可关闭）。
8. **不实现 Cookie/账号管理**：webview 共享思源主进程 session，复杂隔离超出范围。
9. **不在 SPA 站点内做 URL 同步**：依赖 `did-navigate-in-page` 事件，已是 Electron 标准 API，足够覆盖大部分 SPA。
10. **`openWindow` 不用于浏览器**：其只支持思源文档块，浏览器统一用 `openTab({ custom: { id: this.name + "browser-tab" } })`。

---

## 五、Verification Steps（验证步骤）

### 5.1 构建验证
- `pnpm install` 成功
- `pnpm run build` 产出 `package.zip`，内含：`index.js`、`index.css`、`kernel.js`、`plugin.json`、`icon.png`、`preview.png`、`i18n/*.json`、`README*.md`
- 解压检查 `plugin.json` 字段完整

### 5.2 安装与加载
- 将 `package.zip` 通过思源"集市 → 已下载 → 从本地安装"导入
- 或将整个项目目录复制到 `{workspace}/data/plugins/siyuan-plugin-browser/`，重启思源后在"设置 → 集市 → 已下载"启用
- 控制台无报错，顶栏出现"浏览器"图标

### 5.3 功能逐项验证
1. **页签与导航**：点击顶栏图标 → 打开浏览器页签；地址栏输入 `b3log.org` 回车 → 加载思源官网；输入 `google.com` → 正常加载（验证绕过 X-Frame-Options）
2. **前进/后退/刷新**：点击几个链接后，后退/前进按钮可用性正确；刷新重新加载当前页
3. **多页签**：连续 `Ctrl+T` 新建多个页签，分别加载不同网站，切换无串扰
4. **`new-window` 拦截**：在 Google 搜索结果页点击链接 → 在新页签打开而非系统浏览器
5. **地址栏同步**：点击页内链接跳转后，地址栏自动更新为新 URL
6. **标题与 favicon**：页签标题随页面 `page-title-updated` 更新；favicon 正确显示
7. **书签**：点击 ☆ 收藏 → 书签 Dock 出现条目；重启思源后仍在
8. **历史**：访问若干页面后，历史 Dock 按日期分组显示；搜索可用；清空生效
9. **下载**：在 webview 内右键图片"另存为" → 下载 Dock 出现进度条 → 完成后在思源 assets 中可找到文件
10. **快捷键**：`Ctrl+T/W/L/R/F` 在浏览器页签激活时生效
11. **右键菜单**：在 webview 内右键 → 出现自定义菜单（后退/前进/刷新/查看源代码/检查元素/复制链接/在新页签打开/另存为）
12. **设置**：修改默认搜索引擎为百度 → 地址栏输入"测试"回车 → 跳转百度搜索
13. **内核插件**：`/api/plugin/listLoadedPlugins` 返回的插件对象 `kernel` 字段非空，RPC `this.kernel.rpc.call.fetchMeta("https://b3log.org")` 返回标题
14. **卸载清理**：禁用插件 → `uninstall()` 删除 storage 数据，无残留

### 5.4 边界情况
- 加载 `about:blank` 不报错
- 加载本地文件 `file:///` 正常
- 网络断开时 `did-fail-load` 触发，显示错误页（自建 HTML 注入 webview `srcdoc`）
- 加载超大页面（如长 Wikipedia）不卡死
- 同时打开 5+ 页签内存占用在可接受范围（webview 独立进程，思源任务管理器可见）

---

## 六、实施顺序建议

1. 项目骨架（package.json/webpack/tsconfig/plugin.json）
2. 前端入口 + 自定义页签 + webview 基础渲染
3. 工具栏（前进/后退/刷新/地址栏）
4. webview 事件路由与状态同步
5. 顶栏按钮 + eventBus 链接菜单集成
6. 内核插件 + RPC（fetchMeta/head/download）
7. 书签 Dock + 持久化
8. 历史 Dock + 持久化
9. 下载 Dock + 内核下载流程
10. 设置对话框
11. 快捷键命令
12. 右键菜单
13. i18n 完善
14. 样式打磨（暗色主题、响应式）
15. 打包测试 + README
