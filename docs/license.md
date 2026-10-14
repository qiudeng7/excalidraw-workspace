# 许可证

[返回目录](../README.md#目录)

Excalidraw Workspace 自己的代码采用 [MIT](../LICENSE) 许可证。纳入仓库并修改的 Excalidraw 代码保留[上游 MIT 版权与许可声明](../packages/excalidraw/LICENSE)，来源版本及本地改动见 [Excalidraw 说明](../packages/excalidraw/README.md)。

## 查看和分发声明

在应用中打开“设置 → 通用 → 开源许可 → 查看声明”，可阅读这两份完整许可，也可打开纯文本声明。许可页面无需登录。

开发服务器、Cloudflare 构建与 Node 构建都会提供 `/licenses.html` 和 `/licenses.txt`；Docker 运行镜像随 `.output` 一起包含这两个文件。[生成脚本](../scripts/licenses.mjs)直接读取仓库的两份 `LICENSE`，在 Nuxt 收集静态资源前生成页面和文本，不另行维护许可副本。Cloudflare 的 [Wrangler 配置](../wrangler.jsonc)使用 `assets.html_handling: "none"`，让许可页面按 `.html` 原路径访问，避免静态资源重定向与 Nitro 路由不一致。

MIT 允许修改、商用和再分发，要求在软件副本或重要部分中保留版权与许可声明，不要求在画布上添加水印。分发源码时保留两份 `LICENSE`；分发构建产物时保留生成的声明文件。

其他第三方组件和字体仍遵循各自许可证。这两份 MIT 声明仅覆盖本项目与 Excalidraw 的相应代码，不替代其他组件的许可。
