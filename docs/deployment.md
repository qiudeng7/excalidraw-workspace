# 部署

命令在仓库根目录执行。源码安装与本地 Worker 调试见 [本地启动](development/local-development.md)，运行验证见[开发验证](development/testing.md)。首次部署后打开页面创建管理员。

## Docker

安装 Docker 与 Compose，在仓库根目录执行：

```sh
docker compose up --build -d
docker compose logs migrations app
```

打开 http://localhost:8080。容器以普通用户运行，不需要 Cloudflare 账户；Docker 使用单实例，数据与在线应用独立。数据库和快照保存在命名卷 `workspace-data`，挂载到 `/app/.data`；迁移成功后应用才启动。迁移失败时修复错误后重新执行启动命令。

对外提供服务时，由反向代理提供 HTTPS，并在 `.env` 设置：

```dotenv
PORT=8080
PUBLIC_ORIGIN=https://draw.example.com
```

端口只绑定回环地址。`PUBLIC_ORIGIN` 填浏览器实际访问的完整 origin，不含路径；仅修改本地端口时，也须同步修改该值。代理须保留 Cookie、Origin 和请求头，不缓存 `/api/*`，并支持 WebSocket Upgrade 和持续连接。按客户端 IP 限流时，将代理连接 IP 填入 `TRUSTED_PROXY_IPS`。修改环境变量后执行 `docker compose up -d`。

## Cloudflare Workers

一个 Cloudflare Worker 同时提供 Nuxt 页面、API 和静态资源。D1 保存账户、会话、工作空间及画布目录，SQLite Durable Objects 保存协作房间权威状态，私有 R2 bucket 保存图片、固定版本及旧画布和素材库快照。部署需要有 Workers、D1 和 R2 操作权限的 Cloudflare 账户。

首次部署到自己的账户，在仓库根目录运行：

```sh
pnpm exec wrangler login --config wrangler.jsonc
pnpm exec wrangler d1 create excalidraw-demo --config wrangler.jsonc
pnpm exec wrangler r2 bucket create excalidraw-demo-data --config wrangler.jsonc
```

将创建结果中的数据库 ID 填入 [wrangler.jsonc](../wrangler.jsonc) 的 `d1_databases[0].database_id`，同时核对 Worker、数据库和 bucket 名称，并将 `vars.PUBLIC_ORIGIN` 改为自己的实际访问 origin（例如 `https://draw.example.com`）；它用于写请求的来源校验。**仓库中的数据库 ID 指向当前在线应用；部署到自己的账户时必须替换成自己的数据库 ID。** 资源名称可以自行修改，但必须与实际创建的资源和配置一致。

当前在线应用使用 `excalidraw-workspace` Worker，地址为 `https://excalidraw-workspace.qiudeng.workers.dev`。D1 仍为 `excalidraw-demo`，R2 bucket 仍为 `excalidraw-demo-data`，继续使用已有账户和画布数据。更换访问域名后需要重新登录。

```sh
pnpm run deploy
```

部署后打开根地址，及时完成首个管理员注册。后续更新时应用新增迁移并重新部署，保留原有数据库及 bucket 绑定。Workers HTTP 应用和静态资源由 Nuxt/Nitro 生成，[server/worker.mjs](../server/worker.mjs) 包装入口并导出协作 Durable Object。关于页由服务端渲染，画布页仅在浏览器渲染。GitHub push 不会自动更新线上服务。

`pnpm run deploy` 依次构建、迁移远程 D1、部署 Worker。D1、R2、SQLite Durable Objects 的 binding 分别为 `DB`、`BLOB`、`CANVAS_ROOMS`；`canvas-room-v1` 迁移创建 `CanvasRoom` 类，不要删除或改写已发布的 DO migration。所有 Wrangler 命令显式使用 `--config wrangler.jsonc`，否则 NuxtHub 自动生成的配置可能绕过自定义 Worker 入口。已有数据库沿用 `d1_migrations`，不要更换迁移记录重跑旧 SQL。

## 单独运行 Node

安装项目依赖后执行：

```sh
pnpm build:node
PUBLIC_ORIGIN=http://localhost:3000 pnpm start:node
```

Node 协作广播仅支持一个应用进程，不支持多副本或 cluster；数据库 CAS 不能替代跨进程广播。数据位于工作目录的 `.data/db/sqlite.db` 和 `.data/blob/`。启动命令先应用迁移；若仅分发 `.output/`，部署流程须先迁移相同数据目录，再执行 `node .output/server/index.mjs`。

## 备份和恢复

Node / Docker 停止写入后备份整个 `.data` 目录或卷，包含数据库、WAL 与快照；恢复时使用兼容版本，并确保运行用户可读写。`docker compose down` 保留命名卷，`down -v` 会删除命名卷。

Cloudflare 必须同时备份 D1、R2 和协作房间状态。**D1 + R2 不再是完整备份**：DO SQLite 与 D1 是不同的数据库。备份时暂停写入；逐张协作画布导出房间状态及全部引用对象，再备份目录和账户数据库。恢复房间必须使用新的 epoch，避免旧设备继续提交恢复前的队列。Node 的整目录恢复也须对协作房间执行下面的恢复步骤来更新 epoch。

房间备份工具使用所有者的登录 Cookie。将 Cookie 放入 `WORKSPACE_COOKIE` 环境变量，避免写进命令历史或仓库；备份包含成员权限和分享链接的哈希，目录权限为 0700、文件为 0600，应作为私有数据保管。

```sh
# directory 必须是尚不存在的目录；origin 和 canvasId 按实际服务填写。
node scripts/room-backup.mjs export https://draw.example.com CANVAS_ID ./room-backup
# 恢复会替换这张画布及其分享权限，并使已有连接和访问凭证失效。
node scripts/room-backup.mjs restore https://draw.example.com CANVAS_ID ./room-backup
```

工具导出房间的权威内容、成员、分享链接、固定版本清单和引用对象。连接 ticket、访问 capability 和去重记录不导出：恢复启用新 epoch，旧队列必须下载后人工恢复。恢复先上传并校验不可变对象，再按当前 epoch、序号和权限版本原子替换房间；上传期间有新修改会拒绝恢复。当前工具仅支持恢复到已有、同 ID、同所有者的画布；整站恢复须先恢复兼容的目录数据库，再逐房间恢复，不能直接跨账户导入。恢复后重新打开编辑器；涉及故障的恢复点、恢复耗时和数据完整性需在目标环境另行演练。

两种部署的数据独立，切换目标须搬迁全部权威数据与对象；代码回滚前确认迁移与协议兼容。启用协作后的画布拒绝旧版整图 PUT，因此不能直接回滚到不认识协作协议的旧前端。
