const path = require("path");
const webpack = require("webpack");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = (env, argv) => {
    const isProd = argv.mode === "production";
    return {
        mode: argv.mode,
        devtool: isProd ? false : "source-map",
        entry: "./src/index.ts",
        output: {
            path: path.resolve(__dirname, ".src"),
            filename: "index.js",
            libraryTarget: "commonjs2",
            libraryExport: "default",
            clean: false,
        },
        resolve: {
            extensions: [".ts", ".js", ".json"],
        },
        externals: [
            { siyuan: "commonjs2 siyuan" },
            // 打进 bundle 的依赖（adm-zip）内部会 require node 内置模块。
            // 注意：思源把插件源码包在 function(require, module, exports) 里 eval，
            // require 是它自己的映射函数，所以这里必须用 "var" 表达式形式直接调
            // window.require（Electron 渲染进程 nodeIntegration），不能用
            // "commonjs2 fs" —— 那会生成 require("fs") 并经由加载器 require 转发。
            ({ request }, callback) => {
                if (["fs", "path", "os", "zlib", "crypto"].includes(request)) {
                    callback(null, `var window.require(${JSON.stringify(request)})`);
                } else {
                    callback();
                }
            },
        ],
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    use: {
                        loader: "esbuild-loader",
                        options: {
                            loader: "ts",
                            target: "es2020",
                        },
                    },
                },
                {
                    test: /\.scss$/,
                    use: [MiniCssExtractPlugin.loader, "css-loader", "sass-loader"],
                },
                {
                    // 摘录用的注入脚本（Readability / 剪藏脚本）以原始字符串内嵌，
                    // 在 webview 页面上下文中通过 executeJavaScript 执行
                    test: /Readability\.js$|clipScript\.js$/,
                    type: "asset/source",
                },
                {
                    // 内置广告隐藏规则（adblock 语法文本）同样以字符串内嵌
                    test: /adblock-rules\.txt$/,
                    type: "asset/source",
                },
                {
                    test: /\.css$/,
                    use: [MiniCssExtractPlugin.loader, "css-loader"],
                },
            ],
        },
        plugins: [
            new webpack.DefinePlugin({
                "process.env.NODE_ENV": JSON.stringify(argv.mode),
            }),
            new MiniCssExtractPlugin({ filename: "index.css" }),
            new CopyPlugin({
                patterns: [
                    { from: "plugin.json", to: "plugin.json" },
                    { from: "icon.png", to: "icon.png", noErrorOnMissing: true },
                    { from: "preview.png", to: "preview.png", noErrorOnMissing: true },
                    { from: "README.md", to: "README.md", noErrorOnMissing: true },
                    { from: "README.zh-CN.md", to: "README.zh-CN.md", noErrorOnMissing: true },
                    { from: "src/i18n", to: "i18n" },
                    { from: "src/preload.js", to: "preload.js" },
                ],
            }),
        ],
    };
};
