# Excalidraw Workspace

[在线使用](https://excalidraw-workspace.qiudeng.workers.dev/) · [GitHub 仓库](https://github.com/qiudeng7/excalidraw-workspace) · [Changelog](https://github.com/qiudeng7/excalidraw-workspace/releases)

Excalidraw Workspace 是一个开发中的在线绘图应用。使用自己的账户管理工作空间，在每个工作空间中创建多个画布，自动保存图形、文字、图片和个人素材库。它基于 Excalidraw 编辑器，默认使用更规整的线条、Nunito 字体和较短的箭头头部。

## 开始使用

打开[在线应用](https://excalidraw-workspace.qiudeng.workers.dev/)，注册或登录后即可绘图。侧边栏用于切换工作空间和画布，也可创建、重命名或删除它们。画布行左侧的手柄可拖拽调整顺序，触摸设备也可使用；聚焦手柄后按上、下方向键即可排序。顺序和最近打开的画布保存在账户中，刷新或换浏览器会恢复，切换工作空间时优先打开该空间最近使用的画布。空空间显示新建入口，不会自动生成画布。个人素材库在同一账户的不同画布间共享。画布默认私有；所有者可以邀请已有账号或生成分享链接，与其他用户和访客协作。

首次访问尚未初始化的服务时，页面会引导创建管理员。管理员和普通用户均使用邮箱、密码登录；注册密码至少 12 位，邮箱只作为登录名，无需邮件验证。工作空间侧边栏底部的“设置”打开统一设置面板，左侧上方分为“通用”“编辑器”“账号”“调试”，管理员专属的“系统设置”位于左侧下方。管理员可在“系统设置”中关闭或重新开放注册；关闭注册后，已有用户仍可登录。外观主题在“通用”中调整，按浏览器保存。

在“账号”中输入原密码、新密码和确认新密码即可修改密码。新密码需为 12–256 个字符，且不能与原密码相同；修改成功后当前登录会话保留，其他登录会话失效，需要使用新密码重新登录。

### 保存和备份

画布和素材库修改后会自动保存到服务端。`Ctrl+S`（macOS 为 `Cmd+S`）也会触发一次云端保存，并显示成功或失败反馈；不会弹出浏览器的网页保存对话框。没有新修改时也会显示保存反馈。

保存失败时，页面会显示提示，并在浏览器中暂存草稿。切换画布先确认本地草稿落盘，旧画布在后台同步；站内跳转或退出登录会等待保存，失败时保留当前画布。刷新或关闭页面前，如有未保存内容会提示确认，但关闭页面不会保证完成保存，离开前请确认已保存。

多个编辑者或同一账号的不同会话可以同时修改画布：不同元素合并，同一元素按版本确定结果；文字按整个文字元素合并，同时修改同一段文字可能采用其中一个版本。素材库仍使用版本比较保护，拒绝旧版本覆盖。画布排序和最近打开位置也有独立版本；发生目录冲突时重新加载列表，最近位置冲突不会强行切换当前画布。遇到冲突可下载本地备份，或确认舍弃冲突草稿后加载云端版本。编辑器菜单也提供文件导入、导出，便于保留独立备份。

图片随画布保存。单次画布或素材库保存上限为 20 MB，超出时会提示错误并保留本地草稿。字体从 Excalidraw 默认 CDN 加载，需要网络访问。

### 分享与查看

打开画布顶部的“分享”，可以按邮箱邀请已有账号，或生成分享链接。所有者管理权限，编辑者可以绘图，查看者保持只读。链接默认要求登录、有效期 7 天，也可允许匿名访问、调整有效期或撤销。被邀请的账号在侧边栏“与我共享”中打开画布。

查看者有三种方式：实时查看持续跟随修改；最新版查看仅在打开或点击“刷新最新版”时读取最新已保存内容，打开后保持不变；固定版本查看始终显示所有者发布的指定版本，包括当时的标题与图片。删除固定版本后，对应访问失效。分享不包含所有者的个人素材库、设置或其他画布。

已经确认编辑权限的会话可在断网时继续编辑，本地草稿重连后合并。权限被撤销、画布被删除或草稿超出合并窗口时停止自动提交，并提供本地下载。首次打开需要联网校验权限。协作同步和连接状态统一显示在顶部的保存状态处。

### 编辑器操作

新图形默认使用规整实线、2px 线宽，选择填充颜色后使用纯色填充；新文字默认使用 Nunito。导入元素保留自己的样式。编辑器包含命令面板、套索、填充桶和自动识别形状工具，工具栏默认位于画布底部，提示显示在工具栏上方；关闭“编辑器”中的“工具栏置底”可切换到顶部。

普通 `Ctrl+C` 复制可编辑元素，`Ctrl+Shift+C` 复制 PNG，可粘贴到支持图片的应用；macOS 使用 Cmd 代替 Ctrl。图片剪贴板需要浏览器权限和 HTTPS 或 localhost 安全上下文。

编辑器菜单的“跳转”分组可前往首页和关于页。通过工作空间侧边栏底部“设置”的“编辑器”和“调试”分类调整编辑器。编辑器开关默认全部开启：关闭 Excalidraw 默认右侧栏、工具栏置底、边缘连线、Nunito 字体、规整线条、纯色填充和短箭头头部；关闭“关闭excalidraw默认侧边栏”开关可恢复素材库与查找入口。调试提供 `1×`、`1.5×`、`2×` 采样倍率及六个 Canvas 渲染开关，默认 `1×`、全部关闭。提高倍率会增加内存和渲染开销，“恢复调试默认”只重置调试项。各项作用和限制见[源码维护说明](packages/excalidraw/README.md#渲染实验开关)。

配置按账户保存在服务端，重新登录或换浏览器后恢复。更改会即时预览，设置面板显示是否已同步；失败可重试，版本冲突时选择采用云端设置或重新提交当前值。无法读取云端设置时暂按默认值显示，设置控件保持只读，重试读取成功后再开放。旧浏览器的调试设置仅通过“调试”分类明确导入到尚无云端配置的账户。

开启连线优化时，普通直线或曲线箭头指向图形内部也会连接到轮廓；拖拽未松手前按住 `Ctrl` 可临时连接内部，释放 Ctrl 恢复边缘，按住 Ctrl 松手则保留内部连接。`Alt`、`Cmd` 沿用原有行为。此轮针对普通箭头与单端点编辑，折线的 Ctrl 内部连接及特殊重叠几何仍沿用原规则。

字体、线条和填充开关影响新建元素的工具默认值，导入或已有图形保留自己的样式。关闭填充开关会恢复上游默认纯色填充，因此可能没有视觉区别。短头开关会重绘已有箭头，图片和 SVG 导出使用同样的头部；`.excalidraw` 文件不记录账户显示选项，在其他编辑器中按其自身规则显示。采样与调试开关不修改场景、撤销历史或导出图片尺寸。

## 本地启动

使用 Node.js 24 LTS 和 [package.json](package.json) 声明的 pnpm 11.24.0。

```sh
git clone https://github.com/qiudeng7/excalidraw-workspace.git
cd excalidraw-workspace
pnpm install --frozen-lockfile
pnpm dev
```

打开 Nuxt 输出的地址，通常为 http://localhost:3000。首次运行会引导创建管理员。本地开发使用 SQLite 和私有文件目录，启动命令先应用迁移，再启动服务；数据默认保存在被 Git 忽略的 `.data/` 中，与线上数据相互独立。

`pnpm dev` 会先构建编辑器源码；修改编辑器后仍需重新构建，连续开发方式见[源码维护说明](packages/excalidraw/README.md#构建和开发)。

```sh
pnpm typecheck       # 生成编辑器声明并检查 Nuxt 前端与后端类型
pnpm test:unit       # 控制器、保存资源与快照的隔离测试
pnpm test:integration # SQLite、存储驱动与 H3 处理器集成测试
pnpm build           # 构建编辑器和 Workers 产物
pnpm build:node      # 构建编辑器和 Node 服务 .output/
```

### 代码检查

在仓库根目录手动运行检查：

```sh
pnpm check           # lint、格式、工具回归、unit、integration 和类型检查
pnpm check:staged    # 只检查 Git 暂存区中的新增、修改和重命名文件
pnpm lint            # ESLint：代码规则与异常处理
pnpm lint --fix      # 手动修复 ESLint 可修复的问题
pnpm format:check    # Prettier：检查排版
pnpm format          # 手动格式化，执行前先确认工作区改动
```

`pnpm check` 会生成编辑器声明并准备 Nuxt；浏览器、Worker 和生产构建按变更范围另外运行，完整命令见[开发验证](docs/development/testing.md)。项目不安装 Git hooks，提交或推送不会自动运行这些检查。

`pnpm check:staged` 对独立的暂存区快照运行 ESLint、Prettier 和 Git 空白检查，不修改工作区或暂存区。它适合部分暂存后的提交检查；修改 ESLint 配置时会检查完整代码范围。Prettier 范围见 [.prettierignore](.prettierignore)。检查脚本放在 `scripts/`，其回归用例与 ESLint 规则测试放在 `tests/lint/`。

安装依赖时，`postinstall` 准备 Nuxt。若使用了 `--ignore-scripts`，随后执行 `pnpm exec nuxt prepare`。

验证本地 Cloudflare 适配器时，执行 `pnpm build`、`pnpm db:migrate:local`、`pnpm dev:worker`，打开 http://localhost:8787。Wrangler 模拟 D1 和 R2，数据在 `.wrangler/` 中，与 Node 开发目录和线上均独立。

## 用 Docker 运行

安装 Docker 与 Compose，在仓库根目录执行：

```sh
docker compose up --build -d
```

打开 http://localhost:8080。容器以普通用户运行，SQLite 和快照一起保存在命名卷 `workspace-data`，重建或重启容器会保留数据。迁移服务成功后才启动应用，不需要 Cloudflare 账户。Docker 是单实例部署，数据与在线应用独立。

默认端口只绑定本机回环地址。对外提供服务时，配置反向代理和 HTTPS，并在 `.env` 设置 `PUBLIC_ORIGIN=https://你的域名`；它用于校验请求来源和设置 Secure cookie。更换本地端口时也需同时修改 `PORT` 与 `PUBLIC_ORIGIN`。

```dotenv
PORT=8080
PUBLIC_ORIGIN=http://localhost:8080
```

备份或搬迁请在停止写入后备份整个 `/app/.data` 卷，包括 SQLite 文件与快照目录；不要只备份数据库。`docker compose down` 保留命名卷，`down -v` 会删除数据。更多配置见[部署说明](docs/deployment.md)。

## 代码与维护

应用使用 Nuxt 4、Vue、TypeScript 和 Pinia，通过浏览器端 React 组件挂载 Excalidraw；依赖由 pnpm workspace 管理。数据库通过 NuxtHub 与 Drizzle 接入：Workers 使用 D1，Node 使用本地 SQLite；快照通过 NuxtHub Blob 保存到 R2 和私有文件目录。

- [开发者指南](docs/development/readme.md)：按功能模块查用例，沿调用流程进入 API 与实现代码。
- [架构与开发约束](docs/development/architecture.md)：状态归属、请求权限、版本控制、快照与迁移。
- [部署说明](docs/deployment.md)：Workers / Docker 部署、升级、备份与恢复。
- [源码维护说明](packages/excalidraw/README.md)：上游来源、内部包关系、编辑器定制位置、构建与升级方式。
- [更新记录](https://github.com/qiudeng7/excalidraw-workspace/releases)：各版本的 Changelog，通过 Git tag 和 GitHub Release 发布。

编辑器基线为上游 `master` 提交 [`438d898`](https://github.com/excalidraw/excalidraw/commit/438d89861f53d8a90ad566113ecac1b83761098f)（2026-09-27）。这里维护的是固定提交的本地源码，通过 `workspace:*` 引用，不再使用 pnpm patch，也不是新的 npm 稳定版。

## 部署到 Cloudflare

一个 Cloudflare Worker 同时提供 Nuxt 页面、API 和静态资源。D1 保存账户、会话、工作空间及画布目录，SQLite Durable Objects 保存协作房间权威状态，私有 R2 bucket 保存图片、固定版本及旧画布和素材库快照。部署需要有 Workers、D1 和 R2 操作权限的 Cloudflare 账户。

首次部署到自己的账户，在仓库根目录运行：

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create excalidraw-demo
pnpm exec wrangler r2 bucket create excalidraw-demo-data
```

将创建结果中的数据库 ID 填入 [wrangler.jsonc](wrangler.jsonc) 的 `d1_databases[0].database_id`，同时核对 Worker、数据库和 bucket 名称，并将 `vars.PUBLIC_ORIGIN` 改为自己的实际访问 origin（例如 `https://draw.example.com`）；它用于写请求的来源校验。完整配置见[部署说明](docs/deployment.md)。**仓库中的数据库 ID 指向当前在线应用；部署到自己的账户时必须替换成自己的数据库 ID。** 资源名称可以自行修改，但必须与实际创建的资源和配置一致。

当前在线应用使用 `excalidraw-workspace` Worker，地址为 `https://excalidraw-workspace.qiudeng.workers.dev`。D1 仍为 `excalidraw-demo`，R2 bucket 仍为 `excalidraw-demo-data`，继续使用已有账户和画布数据。更换访问域名后需要重新登录。

```sh
pnpm db:migrate:remote
pnpm run deploy
```

部署后打开根地址，及时完成首个管理员注册。后续更新时应用新增迁移并重新部署，保留原有数据库及 bucket 绑定。Workers HTTP 应用和静态资源由 Nuxt/Nitro 生成，[server/worker.mjs](server/worker.mjs) 包装入口并导出协作 Durable Object；Wrangler 命令须显式使用 `--config wrangler.jsonc`。关于页由服务端渲染，画布页仅在浏览器渲染。GitHub push 不会自动更新线上服务。

## 许可证

本项目自己的代码采用 [MIT](LICENSE) 许可证。纳入仓库的 Excalidraw 源码保留[上游 MIT 许可证](packages/excalidraw/LICENSE)，内部 `fractional-indexing` 包沿用 CC0-1.0，字体遵循各字体目录中的许可文件。
