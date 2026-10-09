# Excalidraw Workspace

[在线使用](https://excalidraw-demo.qiudeng.workers.dev/) · [GitHub 仓库](https://github.com/qiudeng7/excalidraw-workspace) · [Changelog](https://github.com/qiudeng7/excalidraw-workspace/releases)

Excalidraw Workspace 是一个开发中的在线绘图应用。使用自己的账户管理工作空间，在每个工作空间中创建多个画布，自动保存图形、文字、图片和个人素材库。它基于 Excalidraw 编辑器，默认使用更规整的线条、Nunito 字体和较短的箭头头部。

## 开始使用

打开[在线应用](https://excalidraw-demo.qiudeng.workers.dev/)，注册或登录后即可绘图。侧边栏用于切换工作空间和画布，也可创建、重命名或删除它们。个人素材库在同一账户的不同画布间共享。账户之间的数据互相隔离，画布不支持多人同时协作。

首次访问尚未初始化的服务时，页面会引导创建管理员。管理员和普通用户均使用邮箱、密码登录；注册密码至少 12 位，邮箱只作为登录名，无需邮件验证。管理员可在侧边栏的“管理设置”中关闭或重新开放注册；关闭注册后，已有用户仍可登录。

### 保存和备份

画布和素材库修改后会自动保存到服务端。`Ctrl+S`（macOS 为 `Cmd+S`）也会触发一次云端保存，并显示成功或失败反馈；不会弹出浏览器的网页保存对话框。没有新修改时也会显示保存反馈。

保存失败时，页面会显示提示，并尽可能在浏览器中暂存草稿。切换画布、站内跳转或退出登录前会等待保存；失败时保留当前画布。刷新或关闭页面前，如有未保存内容会提示确认，但关闭页面不会保证完成保存，离开前请确认已保存。

多个标签页修改同一份内容时，服务端会拒绝旧版本覆盖。遇到冲突可下载本地备份，或确认舍弃冲突草稿后加载云端版本。编辑器菜单也提供文件导入、导出，便于保留独立备份。

图片随画布保存。单次画布或素材库保存上限为 20 MB，超出时会提示错误并保留本地草稿。字体从 Excalidraw 默认 CDN 加载，需要网络访问。

### 编辑器操作

新图形默认使用规整实线、2px 线宽，选择填充颜色后使用纯色填充；新文字默认使用 Nunito。导入元素保留自己的样式。编辑器包含命令面板、套索、填充桶和自动识别形状工具，工具栏位于画布底部，提示显示在工具栏上方。

普通 `Ctrl+C` 复制可编辑元素，`Ctrl+Shift+C` 复制 PNG，可粘贴到支持图片的应用；macOS 使用 Cmd 代替 Ctrl。图片剪贴板需要浏览器权限和 HTTPS 或 localhost 安全上下文。

菜单的“跳转”分组可前往首页和关于页；“debug”分组提供 `1×`、`1.5×`、`2×` 采样倍率和独立的 Canvas 渲染开关，用于比较显示效果。设置只保存在当前浏览器，不修改场景数据、撤销历史或导出图片尺寸。提高倍率会增加内存和渲染开销；“恢复默认渲染设置”会恢复 `1×` 并关闭所有实验开关。各开关的作用和限制见[源码维护说明](packages/excalidraw/README.md#渲染实验开关)。

## 本地启动

推荐 Node.js 24 LTS；最低要求 Node.js 22.13。使用 [package.json](package.json) 声明的 pnpm 11.24.0。

```sh
git clone https://github.com/qiudeng7/excalidraw-workspace.git
cd excalidraw-workspace
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate:local
pnpm dev:worker
```

打开 http://localhost:8787。首次运行会显示管理员创建页面，完成注册后进入画布。Wrangler 在本机模拟 Worker、D1 和 R2，不需要云端数据库权限；本地数据保存在被 Git 忽略的 `.wrangler/` 中，与线上数据相互独立。

开发前端时保持 Worker 运行，另开终端在仓库根目录执行：

```sh
pnpm dev
```

访问 Vite 输出的地址，通常为 http://localhost:5173。Vite 将 `/api` 请求代理至本地 Worker。`pnpm dev` 会先构建编辑器源码；修改编辑器源码后仍需重新构建，连续开发方式见[源码维护说明](packages/excalidraw/README.md#构建和开发)。

```sh
pnpm build            # 构建编辑器、检查前端类型并生成 dist/
pnpm typecheck:worker # 检查后端类型
pnpm test:backend     # 本地 D1/R2 集成测试，不访问线上数据
```

## 代码与维护

前端使用 Vue、Vite、TypeScript、Pinia 和 Vue Router，通过 React 挂载 Excalidraw；依赖由 pnpm workspace 管理。

- [源码维护说明](packages/excalidraw/README.md)：上游来源、内部包关系、编辑器定制位置、构建与升级方式。
- [更新记录](https://github.com/qiudeng7/excalidraw-workspace/releases)：各版本的 Changelog，通过 Git tag 和 GitHub Release 发布。
- [页面与路由](src/views/)及[路由定义](src/router/index.ts)：账户入口、侧边栏和画布页面。根路径 `/` 是画布，`/home` 为首页，`/about` 为关于页；旧地址 `/draw` 跳转到 `/`。
- [编辑器包装组件](src/components/ExcalidrawCanvas.vue)：Vue 与 React 的衔接、默认样式、菜单和云端保存。
- [自动保存队列](src/lib/persistence.ts)：保存去抖、本地草稿和冲突处理。
- [Worker 后端](worker/index.ts)与[数据库迁移](migrations/)：账户、访问权限、工作空间、画布和素材库 API。

编辑器基线为上游 `master` 提交 [`438d898`](https://github.com/excalidraw/excalidraw/commit/438d89861f53d8a90ad566113ecac1b83761098f)（2026-09-27）。这里维护的是固定提交的本地源码，通过 `workspace:*` 引用，不再使用 pnpm patch，也不是新的 npm 稳定版。

## 部署到 Cloudflare

一个 Cloudflare Worker 同时提供 API 和静态页面。D1 保存账户、会话、工作空间及画布目录，私有 R2 bucket 保存画布和素材库快照。部署需要有 Workers、D1 和 R2 操作权限的 Cloudflare 账户。

首次部署到自己的账户，在仓库根目录运行：

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create excalidraw-demo
pnpm exec wrangler r2 bucket create excalidraw-demo-data
```

将创建结果中的数据库 ID 填入 [wrangler.jsonc](wrangler.jsonc) 的 `d1_databases[0].database_id`，同时核对 Worker、数据库和 bucket 名称。**仓库中的数据库 ID 指向当前在线应用；部署到自己的账户时必须替换成自己的数据库 ID。** 资源名称可以自行修改，但必须与实际创建的资源和配置一致。

当前在线应用继续使用 `excalidraw-demo` Worker、D1 和 `excalidraw-demo-data` R2 bucket，产品改名未迁移这些资源，因此访问地址和已有用户数据保持原有位置。

```sh
pnpm db:migrate:remote
pnpm typecheck:worker
pnpm deploy
```

部署后打开根地址，及时完成首个管理员注册。后续更新时应用新增迁移并重新部署，保留原有数据库及 bucket 绑定。静态资源来自 `dist/`，`/api/*` 交给 Worker，其余页面支持 SPA 路由回退。GitHub push 不会自动更新线上服务。

## 许可证

本项目自己的代码采用 [MIT](LICENSE) 许可证。纳入仓库的 Excalidraw 源码保留[上游 MIT 许可证](packages/excalidraw/LICENSE)，内部 `fractional-indexing` 包沿用 CC0-1.0，字体遵循各字体目录中的许可文件。
