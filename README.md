# excalidraw Demo

[在线体验 Demo](https://excalidraw-demo.qiudeng.workers.dev/draw) · [GitHub 仓库](https://github.com/qiudeng7/excalidraw-demo)

本项目是一次未成功的 demo 实验，下面是实验经过
1. 使用 Vue + Vite + TypeScript + Pinia + Router 搭建 Demo，通过 React 接入 Excalidraw，使用 pnpm 管理依赖。
2. 将默认样式调整为 Nunito 字体、规整实线和纯色填充，缩短普通箭头的头部（通过pnpm的patch机制修改excalidraw包），让它的样式看起来更正式一些，不那么手写体
3. 隐藏外链菜单，将工具栏移到底部、提示移到工具栏上方，支持 Ctrl+Shift+C 复制 PNG。
4. 最初使用 pnpm patch 定制，后来将 Excalidraw v0.18.1 源码纳入仓库，内部 math/utils 包放到 packages/excalidraw/lib/，统一由 workspace 管理。
5. 针对清晰度问题，加入 采样倍率、缓存平滑、文字和图形直接绘制、像素对齐等实验开关，方便比较不同渲染组合。

最终，清晰度调整未达到我的期望，因此决定结束这次 Excalidraw/Canvas 路线的尝试，后续探索基于 HTML/SVG 的白板实现。这个仓库保留作为实验记录。



## 启动

需要 Node.js 22.12+（或 24+）和 pnpm 11。在项目目录运行：

```sh
pnpm install
pnpm dev
```

打开 Vite 输出的地址，通常为 http://localhost:5173。

```sh
pnpm build   # 构建本地编辑器、类型检查，并构建 Demo 到 dist/
pnpm preview # 本地预览生产构建
```

生产部署需要将 `/about`、`/draw` 等前端路由回退到 `index.html`。

## 使用画布

点击导航中的“画布”，或访问 `/draw`，即可绘制图形、文字和自由笔画。通过编辑器菜单保存到文件，再次使用时从文件打开。画布不会自动保存，离开页面或刷新会清空未保存内容。字体使用 Excalidraw 默认 CDN，需要网络访问。

新图形默认使用规整实线、2px 线宽，选择填充颜色后使用纯色填充；文字默认使用 Nunito。导入元素保留自己的样式。普通开口箭头的头部已缩短，菜单中的 “Excalidraw links” 外链组已移除。

普通 `Ctrl+C` 复制可编辑元素，`Ctrl+Shift+C` 复制 PNG，可粘贴到支持图片的应用。macOS 使用 Cmd 代替 Ctrl。

菜单中的“采样倍率”可选择 `1×`（默认）、`1.5×` 或 `2×`，在设备原生像素密度基础上提高画布采样精度，并记住当前浏览器的选择。该设置不改变画布缩放或导出图片尺寸；倍率越高，内存和渲染开销越大。

采样倍率下方的“渲染实验”提供独立开关：缓存位图平滑、高质量平滑、文字直接绘制、简单图形直接绘制、绘制位置对齐像素，以及始终平滑显示画布。全部默认关闭，可自由组合；高质量平滑需先开启缓存位图平滑。选项自动保留，“恢复默认渲染设置”会关闭全部开关并恢复 `1×`。鼠标停留在选项上可查看作用与限制。

## 代码与定制

- [路由](src/router/index.ts)、[页面](src/views/)和 [Pinia 计数器](src/stores/counter.ts)。
- [Vue 包装组件](src/components/ExcalidrawCanvas.vue)：挂载 React 编辑器、设置默认样式和菜单，离开页面时卸载。
- [本地 Excalidraw 源码](packages/excalidraw/README.md)：源码来源、三个内部包的关系、定制位置、构建和升级方式。

Demo 宿主的直接依赖已于 2026-09-27 核对稳定版本。React 及其类型保留在 18，因为 Excalidraw 的部分传递依赖尚未声明支持 React 19。TypeScript 保留在 6.0.3，因为当前 `vue-tsc` 3.3.11 搭配 TypeScript 7.0.2 实测报错 `ERR_PACKAGE_PATH_NOT_EXPORTED`；升级时需重新检查兼容性。

Excalidraw 已作为本仓库的本地源码包维护，使用 `workspace:*` 引用，不再应用 pnpm patch。`pnpm dev` 会先构建编辑器再启动 Vite；首次启动需等待源码构建完成。编辑器内部构建工具保留上游兼容版本，详情见 [源码维护说明](packages/excalidraw/README.md)。

## 部署到 Cloudflare

本 Demo 使用 Cloudflare Workers Static Assets 托管。安装 Wrangler 4 CLI 并登录自己的 Cloudflare 账号后，在仓库根目录运行：

```sh
wrangler login
pnpm build
wrangler deploy
```

部署配置见 [wrangler.jsonc](wrangler.jsonc)，上传目录为 `dist/`，并已配置单页应用路由回退。部署到自己的账号时可修改配置中的 `name`。当前采用手动部署，GitHub push 不会自动更新线上 Demo。

## 许可证

本项目自己的代码采用 [MIT](LICENSE) 许可证。纳入仓库的 Excalidraw 源码保留[上游 MIT 许可证](packages/excalidraw/LICENSE)，字体遵循各字体目录中的许可文件。
