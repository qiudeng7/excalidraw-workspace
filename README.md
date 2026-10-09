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

使用 Node.js 24 LTS 和 [package.json](package.json) 声明的 pnpm 11.24.0。

```sh
git clone https://github.com/qiudeng7/excalidraw-workspace.git
cd excalidraw-workspace
pnpm install --frozen-lockfile
pnpm dev
```

打开 Nuxt 输出的地址，通常为 http://localhost:3000。首次运行会引导创建管理员。本地开发使用 SQLite 和私有文件目录，首次启动自动应用迁移；数据默认保存在被 Git 忽略的 `.data/` 中，与线上数据相互独立。

`pnpm dev` 会先构建编辑器源码；修改编辑器后仍需重新构建，连续开发方式见[源码维护说明](packages/excalidraw/README.md#构建和开发)。

```sh
pnpm typecheck       # 检查 Nuxt 前端与后端类型
pnpm test:backend    # 本地存储与 API 集成测试
pnpm build           # 构建编辑器和 Workers 产物
pnpm build:node      # 构建编辑器和 Node 服务 .output/
```

验证本地 Cloudflare 适配器时，执行 `pnpm build`、`pnpm db:migrate:local`、`pnpm dev:worker`，打开 http://localhost:8787。Wrangler 模拟 D1 和 R2，数据在 `.wrangler/` 中，与 Node 开发目录和线上均独立。

## 用 Docker 运行

安装 Docker 与 Compose，在仓库根目录执行：

```sh
docker compose up --build -d
```

打开 http://localhost:8080。容器以普通用户运行，SQLite 和快照一起保存在命名卷 `workspace-data`，重建或重启容器会保留数据。首次启动自动应用数据库迁移，不需要 Cloudflare 账户。Docker 是单实例部署，数据与在线应用独立。

默认端口只绑定本机回环地址。对外提供服务时，配置反向代理和 HTTPS，并在 `.env` 设置 `PUBLIC_ORIGIN=https://你的域名`；它用于校验请求来源和设置 Secure cookie。更换本地端口时也需同时修改 `PORT` 与 `PUBLIC_ORIGIN`。

```dotenv
PORT=8080
PUBLIC_ORIGIN=http://localhost:8080
```

备份或搬迁请在停止写入后备份整个 `/data` 卷，包括 SQLite 文件与快照目录；不要只备份数据库。`docker compose down` 保留命名卷，`down -v` 会删除数据。更多配置见[部署说明](docs/deployment.md)。

## 代码与维护

应用使用 Nuxt 4、Vue、TypeScript 和 Pinia，通过浏览器端 React 组件挂载 Excalidraw；依赖由 pnpm workspace 管理。Workers 与 Node 共用业务服务，分别适配 D1/R2 和 SQLite/文件目录。

- [源码维护说明](packages/excalidraw/README.md)：上游来源、内部包关系、编辑器定制位置、构建与升级方式。
- [更新记录](https://github.com/qiudeng7/excalidraw-workspace/releases)：各版本的 Changelog，通过 Git tag 和 GitHub Release 发布。
- [页面与路由](src/pages/)及[Nuxt 配置](nuxt.config.ts)：账户入口、侧边栏和画布页面。根路径 `/` 是画布，`/home` 为首页，`/about` 为关于页；旧地址 `/draw` 跳转到 `/`。
- [编辑器包装组件](src/components/ExcalidrawCanvas.client.vue)：Vue 与 React 的衔接、默认样式、菜单和云端保存。
- [自动保存队列](src/lib/persistence.ts)：保存去抖、本地草稿和冲突处理。
- [后端服务与存储适配器](server/)和[数据库迁移](migrations/)：账户、访问权限、工作空间、画布和素材库 API。

编辑器基线为上游 `master` 提交 [`438d898`](https://github.com/excalidraw/excalidraw/commit/438d89861f53d8a90ad566113ecac1b83761098f)（2026-09-27）。这里维护的是固定提交的本地源码，通过 `workspace:*` 引用，不再使用 pnpm patch，也不是新的 npm 稳定版。

## 部署到 Cloudflare

一个 Cloudflare Worker 同时提供 Nuxt 页面、API 和静态资源。D1 保存账户、会话、工作空间及画布目录，私有 R2 bucket 保存画布和素材库快照。部署需要有 Workers、D1 和 R2 操作权限的 Cloudflare 账户。

首次部署到自己的账户，在仓库根目录运行：

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create excalidraw-demo
pnpm exec wrangler r2 bucket create excalidraw-demo-data
```

将创建结果中的数据库 ID 填入 [wrangler.jsonc](wrangler.jsonc) 的 `d1_databases[0].database_id`，同时核对 Worker、数据库和 bucket 名称，并将 `vars.PUBLIC_ORIGIN` 改为自己的实际访问 origin（例如 `https://draw.example.com`）；它用于写请求的来源校验。完整配置见[部署说明](docs/deployment.md)。**仓库中的数据库 ID 指向当前在线应用；部署到自己的账户时必须替换成自己的数据库 ID。** 资源名称可以自行修改，但必须与实际创建的资源和配置一致。

当前在线应用继续使用 `excalidraw-demo` Worker、D1 和 `excalidraw-demo-data` R2 bucket，产品改名未迁移这些资源，因此访问地址和已有用户数据保持原有位置。

```sh
pnpm db:migrate:remote
pnpm typecheck:worker
pnpm deploy
```

部署后打开根地址，及时完成首个管理员注册。后续更新时应用新增迁移并重新部署，保留原有数据库及 bucket 绑定。Workers 入口和静态资源由 Nuxt/Nitro 生成，首页与关于页支持服务端渲染，画布仅在浏览器渲染。GitHub push 不会自动更新线上服务。

## 许可证

本项目自己的代码采用 [MIT](LICENSE) 许可证。纳入仓库的 Excalidraw 源码保留[上游 MIT 许可证](packages/excalidraw/LICENSE)，内部 `fractional-indexing` 包沿用 CC0-1.0，字体遵循各字体目录中的许可文件。
