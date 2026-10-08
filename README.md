# excalidraw Demo

[在线体验 Demo](https://excalidraw-demo.qiudeng.workers.dev/) · [GitHub 仓库](https://github.com/qiudeng7/excalidraw-demo)

在线版本已接入账户、工作空间、画布和个人素材库的云端保存。

本项目是一个持续定制中的 Excalidraw Demo，下面记录这次尝试的经过。

1. 使用 Vue + Vite + TypeScript + Pinia + Router 搭建 Demo，通过 React 接入 Excalidraw，使用 pnpm 管理依赖。
2. 将默认样式调整为 Nunito 字体、规整实线和纯色填充，缩短普通箭头的头部（当时通过 pnpm patch 修改 Excalidraw 包），让它的样式看起来更正式一些，不那么手写体
3. 隐藏外链菜单，将工具栏移到底部、提示移到工具栏上方，支持 Ctrl+Shift+C 复制 PNG。
4. 最初使用 pnpm patch 定制，后来将 Excalidraw v0.18.1 源码纳入仓库，内部 math/utils 包放到 packages/excalidraw/lib/，统一由 workspace 管理。
5. 针对清晰度问题，加入 采样倍率、缓存平滑、文字和图形直接绘制、像素对齐等实验开关，方便比较不同渲染组合。

清晰度调整一度没有达到我的期望，我曾放下 Excalidraw/Canvas 路线，考虑转向 HTML/SVG。后来觉得目前的分辨率可以接受，决定继续完善这个 Demo。仓库也保留这段中途放弃、又继续尝试的记录。

## 启动

需要 Node.js 22.12+（或 24+）和 pnpm 11。在项目目录运行：

```sh
pnpm install
pnpm build
pnpm db:migrate:local
pnpm dev:worker
```

打开 http://localhost:8787。Wrangler 在本机模拟 D1、R2 和 Worker，不需要云端数据库权限；本地数据保存在被 Git 忽略的 `.wrangler/` 中。

开发前端时保持这个终端运行，另开一个终端执行 `pnpm dev`，访问 Vite 输出的地址（通常是 http://localhost:5173）。Vite 会把 `/api` 请求代理给本地 Worker。编辑器源码变更仍需重新构建。

```sh
pnpm build            # 编辑器源码、Demo 类型检查和生产构建
pnpm typecheck:worker # 后端类型检查
pnpm test:backend     # 本地 D1/R2 集成测试，不访问线上数据
```

## 账户与工作空间

首次访问尚未初始化的服务时，页面会引导创建管理员。管理员和普通用户都用邮箱、密码登录，密码至少 12 位；邮箱只作为登录名，不验证邮件。Cloudflare 免费方案不能向任意注册邮箱发送验证邮件，详见[邮件定价](https://developers.cloudflare.com/email-service/platform/pricing/)。

管理员可在侧边栏的“管理员设置”中开关新用户注册，已有用户仍可登录。每个用户只能访问自己的工作空间、画布和素材库。工作空间及画布可创建、重命名、删除；删除工作空间会同时删除其中的画布。

画布和素材库在修改后自动保存。保存失败时会显示提示，并尽可能在本机暂存草稿；切换画布、站内跳转或退出登录前会等待保存完成；失败时会保留当前画布。关闭或刷新页面时，若有未保存内容会提示确认。多个标签页修改同一份内容时，服务端会拒绝旧版本覆盖：可以下载本地备份，或确认舍弃冲突草稿后加载云端版本。素材库属于用户账户，可在自己的不同画布间使用。

## 使用画布

打开根路径 `/` 即可进入全屏画布，绘制图形、文字和自由笔画；旧地址 `/draw` 会跳转到 `/`。编辑器菜单中的“跳转”分组可前往 `/home` 首页和 `/about` 关于页，这些页面保留导航栏。

画布会保存到当前账户，也可通过编辑器菜单导入、导出文件。图片随画布保存；单次画布或素材库保存限制为 20 MB，超过限制会显示错误并保留本地草稿。字体使用 Excalidraw 默认 CDN，需要网络访问。

新图形默认使用规整实线、2px 线宽，选择填充颜色后使用纯色填充；文字默认使用 Nunito。导入元素保留自己的样式。普通开口箭头的头部已缩短，菜单中的 “Excalidraw links” 外链组已移除。

普通 `Ctrl+C` 复制可编辑元素，`Ctrl+Shift+C` 复制 PNG，可粘贴到支持图片的应用。macOS 使用 Cmd 代替 Ctrl。

菜单中 “debug” 分组的“采样倍率”可选择 `1×`（默认）、`1.5×` 或 `2×`，在设备原生像素密度基础上提高画布采样精度，并记住当前浏览器的选择。该设置不改变画布缩放或导出图片尺寸；倍率越高，内存和渲染开销越大。

同一分组在采样倍率下方提供独立的渲染实验开关：缓存位图平滑、高质量平滑、文字直接绘制、简单图形直接绘制、绘制位置对齐像素，以及始终平滑显示画布。全部默认关闭，可自由组合；高质量平滑需先开启缓存位图平滑。选项自动保留，“恢复默认渲染设置”会关闭全部开关并恢复 `1×`。鼠标停留在选项上可查看作用与限制。

## 代码与定制

- [路由](src/router/index.ts)、[页面](src/views/)和 [Pinia 计数器](src/stores/counter.ts)。
- [Vue 包装组件](src/components/ExcalidrawCanvas.vue)：挂载 React 编辑器、设置默认样式与菜单，接入画布和素材库保存。
- [自动保存队列](src/lib/persistence.ts)：保存去抖、草稿恢复和冲突处理。
- [Worker 后端](worker/index.ts)与[数据库迁移](migrations/)：账户、访问权限、工作空间、画布和素材库 API。
- [本地 Excalidraw 源码](packages/excalidraw/README.md)：源码来源、内部包的关系、定制位置、构建和升级方式。

Demo 宿主的直接依赖已于 2026-09-27 核对稳定版本。React 及其类型沿用 18，本次源码升级也针对这一版本完成适配。TypeScript 保留在 6.0.3，因为当前 `vue-tsc` 3.3.11 搭配 TypeScript 7.0.2 实测报错 `ERR_PACKAGE_PATH_NOT_EXPORTED`；升级时需重新检查兼容性。

当前编辑器基线为上游 `master` 提交 [`438d898`](https://github.com/excalidraw/excalidraw/commit/438d89861f53d8a90ad566113ecac1b83761098f)（2026-09-27），包含套索、填充桶和自动识别形状的 Autoshape。这里使用的是固定提交的开发版源码，并非新的 npm 稳定版。

Excalidraw 已作为本仓库的本地源码包维护，使用 `workspace:*` 引用，不再应用 pnpm patch。`pnpm dev` 会先构建编辑器再启动 Vite；首次启动需等待源码构建完成。编辑器内部构建工具保留上游兼容版本，详情见 [源码维护说明](packages/excalidraw/README.md)。

## 部署到 Cloudflare

本项目使用一个 Cloudflare Worker 同时提供 API 和静态页面：D1 保存账号、会话及目录信息，私有 R2 bucket 保存画布和素材库快照。需要具有 Workers、D1 和 R2 操作权限的 Cloudflare 登录。

首次部署到自己的账号：

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create excalidraw-demo
pnpm exec wrangler r2 bucket create excalidraw-demo-data
```

将创建结果中的数据库 ID 填入 [wrangler.jsonc](wrangler.jsonc) 的 `d1_databases[0].database_id`，同时核对账号下的 Worker、数据库及 bucket 名称。仓库中的数据库 ID 指向当前 Demo；部署到自己的账号时，必须替换为自己新建的数据库 ID。

```sh
pnpm db:migrate:remote
pnpm typecheck:worker
pnpm deploy
```

部署后打开根地址，由实际使用者完成首个管理员注册。之后更新代码通常只需应用新增迁移并重新部署。静态资源来自 `dist/`，`/api/*` 交给 Worker，其余页面支持 SPA 路由回退。GitHub push 不会自动更新线上服务。云端 D1/R2 与本机模拟数据相互独立。

## 许可证

本项目自己的代码采用 [MIT](LICENSE) 许可证。纳入仓库的 Excalidraw 源码保留[上游 MIT 许可证](packages/excalidraw/LICENSE)，内部 `fractional-indexing` 包沿用 CC0-1.0，字体遵循各字体目录中的许可文件。
