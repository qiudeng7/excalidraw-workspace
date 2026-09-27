# Vue Demo

一个基于 Vue 3、Vite、TypeScript、Pinia 和 Vue Router 的 Excalidraw 画布 Demo。首页提供计数器，切换到关于页再返回时保留计数，刷新后重置。

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

## 代码与定制

- [路由](src/router/index.ts)、[页面](src/views/)和 [Pinia 计数器](src/stores/counter.ts)。
- [Vue 包装组件](src/components/ExcalidrawCanvas.vue)：挂载 React 编辑器、设置默认样式和菜单，离开页面时卸载。
- [本地 Excalidraw 源码](packages/excalidraw/README.md)：源码来源、三个内部包的关系、定制位置、构建和升级方式。

Demo 宿主的直接依赖已于 2026-09-27 核对稳定版本。React 及其类型保留在 18，因为 Excalidraw 的部分传递依赖尚未声明支持 React 19。TypeScript 保留在 6.0.3，因为当前 `vue-tsc` 3.3.11 搭配 TypeScript 7.0.2 实测报错 `ERR_PACKAGE_PATH_NOT_EXPORTED`；升级时需重新检查兼容性。

Excalidraw 已作为本仓库的本地源码包维护，使用 `workspace:*` 引用，不再应用 pnpm patch。`pnpm dev` 会先构建编辑器再启动 Vite；首次启动需等待源码构建完成。编辑器内部构建工具保留上游兼容版本，详情见 [源码维护说明](packages/excalidraw/README.md)。
