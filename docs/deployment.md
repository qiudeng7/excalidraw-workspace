# 部署

命令在仓库根目录执行。源码安装与本地 Worker 调试见 [本地启动](development/local-development.md)，运行验证见[开发验证](development/testing.md)。首次部署后打开页面创建管理员。

## Docker

安装 Docker 与 Compose。容器启动时会自动应用数据库迁移，成功后才开始提供服务；首次部署和后续更新使用相同流程。容器以普通用户运行，Docker 使用单实例，数据与在线应用独立。

### GHCR 镜像

下载 [compose.ghcr.yaml](../compose.ghcr.yaml) 到部署目录，执行：

```sh
docker compose -f compose.ghcr.yaml pull
docker compose -f compose.ghcr.yaml up -d --remove-orphans
docker compose -f compose.ghcr.yaml logs app
```

打开 http://localhost:8080。默认拉取 `ghcr.io/qiudeng7/excalidraw-workspace:latest`，当前支持 `linux/amd64`。更新时先[备份数据](#备份和恢复)，再执行同样的 `pull` 和 `up` 命令。应用重建后先完成迁移，再接收请求；迁移失败会退出，查看 `logs app` 排查原因。回退应用版本前确认数据库兼容性或恢复备份。

如需固定版本，可在 `.env` 设置 `WORKSPACE_VERSION=0.5.1`（以[包页面](https://github.com/qiudeng7/excalidraw-workspace/pkgs/container/excalidraw-workspace)的实际标签为准）；自建 fork 可设置 `WORKSPACE_IMAGE=ghcr.io/你的账号/仓库名`。`latest` 和 `main` 跟随主分支，`v<版本>` tag 生成不带 `v` 的版本标签，预发行版保留完整版本号，同时提供完整 SHA 标签。

镜像由 [Container images 工作流](../.github/workflows/containers.yml) 构建。首次发布需先将工作流合入 `main` 并等待成功，再将 GitHub 仓库 Packages 中的 `excalidraw-workspace` 设为 Public；公开仓库不会自动使包公开，已存在的包还需允许本仓库 Actions 写入。需要重试时，在 Actions → Container images → Run workflow 选择 `main`；手动运行其他分支会跳过构建与发布。

### 源码构建

在仓库根目录执行：

```sh
docker compose up --build -d --remove-orphans
docker compose logs app
```

源码更新后先备份，再执行相同命令重新构建和启动。

### 数据与访问配置

数据库和快照保存在命名卷 `workspace-data`，挂载到 `/app/.data`。从旧版双容器方案或源码方式切换时，保持原部署目录和 Compose 项目名（使用过 `-p` 时沿用相同值），以继续使用原命名卷；`--remove-orphans` 会移除旧迁移容器，保留数据卷。

对外提供服务时，由反向代理提供 HTTPS，并在 `.env` 设置：

```dotenv
PORT=8080
PUBLIC_ORIGIN=https://draw.example.com
```

端口只绑定回环地址。`PUBLIC_ORIGIN` 填浏览器实际访问的完整 origin，不含路径；仅修改本地端口时，也须同步修改该值。代理须保留 Cookie、Origin 和请求头，不缓存 `/api/*`，并支持 WebSocket Upgrade 和持续连接。按客户端 IP 限流时，将代理连接 IP 填入 `TRUSTED_PROXY_IPS`。修改环境变量后，源码方式执行 `docker compose up -d --remove-orphans`，GHCR 方式执行 `docker compose -f compose.ghcr.yaml up -d --remove-orphans`。

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

### 持久 preview 验收环境

本项目使用传统 `env.preview` 部署一个独立、持久的 preview Worker，不使用 Workers Previews。`dev` 集成提交部署到固定验收站，`main` 的正式发布提交部署到生产；Git push 不会自动部署任一环境。

| 资源                  | 生产（顶层配置）                                 | preview（`env.preview`）                                 |
| --------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| Worker                | `excalidraw-workspace`                           | `excalidraw-workspace-preview`                           |
| URL / `PUBLIC_ORIGIN` | https://excalidraw-workspace.qiudeng.workers.dev | https://excalidraw-workspace-preview.qiudeng.workers.dev |
| D1（`DB`）            | `excalidraw-demo`                                | `excalidraw-workspace-preview`                           |
| 私有 R2（`BLOB`）     | `excalidraw-demo-data`                           | `excalidraw-workspace-preview-data`                      |
| DO（`CANVAS_ROOMS`）  | 本 Worker 的 `CanvasRoom`                        | preview Worker 自己的 `CanvasRoom`，无 `script_name`     |

preview 使用独立空数据库、独立 bucket 和独立 DO 命名空间，不复制生产账号或数据；之后更新保留 preview 自己的数据。两边都每小时执行一次清理任务（`0 * * * *`），各自仅访问自己的绑定。preview 继承顶层 `canvas-room-v1` DO migration，不重写历史迁移。R2 保持私有，不开启公共桶或 `r2.dev` 访问。

此验收站不配置 Cloudflare Access。首次上线后由用户本人注册首个管理员，并在应用管理设置关闭注册；不得预置管理员或公网默认密码。**关闭注册不是访问隔离**：站点仍可从公网访问，已有账号和分享访问仍按应用权限生效。管理员完成初始化前不要把站点当作已封闭的测试环境。

首次资源创建由获授权的部署者执行，已有资源不要重复创建：

```sh
pnpm exec wrangler d1 create excalidraw-workspace-preview --env preview --config wrangler.jsonc
pnpm exec wrangler r2 bucket create excalidraw-workspace-preview-data --env preview --config wrangler.jsonc
```

将新数据库 UUID 写入 `env.preview.d1_databases[0].database_id`，确认上述资源属于目标账户。不要把生产 UUID 用作临时值。顶层生产配置不变；`env.preview` 必须显式声明 D1、R2、DO 和变量。部署脚本固定本项目 preview 名称与 URL，迁移到其他账户或域名时须同时审阅配置和脚本中的目标校验。

在独立 worktree 安装自己的依赖，避免与正在运行的本地预览共用 `.nuxt`、`.output` 或编辑器构建目录。先验证构建与绑定，不写入云端：

```sh
pnpm install
pnpm run deploy:preview --dry-run
```

`--dry-run` 允许任务分支及未提交修改，只执行 Cloudflare 构建和 `wrangler deploy --dry-run --env preview --config wrangler.jsonc`，不迁移远端数据库，也不发布 Worker。检查输出使用 `server/worker.mjs` wrapper、包含 `CanvasRoom` 导出，且所有绑定都是 preview 资源；本地 bundle 验证不替代线上验收。

合入 `dev` 后，从干净、已提交且 `HEAD` 等于本地 `refs/heads/dev` 的 worktree 执行真实部署；允许独立 worktree detached checkout 到该提交，无须打断主 worktree 的预览服务：

```sh
pnpm run deploy:preview
```

脚本检查资源隔离、有效且非生产的 D1 UUID、DO 不跨 Worker，并打印非敏感部署目标；检查失败立即退出。执行顺序为 Cloudflare 构建 → `pnpm db:migrate:preview` → `wrangler deploy --env preview --config wrangler.jsonc`。脚本不接受覆盖 env、config、name 的参数。仅需单独应用 preview 迁移时，可由获授权的部署者执行 `pnpm db:migrate:preview`；该命令直接写入远端 preview D1，不包含完整部署脚本的安全检查。生产仍使用 `pnpm run deploy`，不能用它更新 preview。

部署者随后核对 preview Worker 的在线版本、D1/R2/DO 绑定、首页、登录和主要改动；首次管理员注册留给用户完成。部署失败时先修复并重跑验证，不以成功构建作为上线成功。回滚 Worker 代码**不会还原 D1、R2 或 DO 数据**；回滚前检查迁移与数据协议兼容性，必要时按[备份和恢复](#备份和恢复)恢复对应环境的数据，不得用生产数据覆盖 preview。

## 单独运行 Node

安装项目依赖后执行：

```sh
pnpm build:node
PUBLIC_ORIGIN=http://localhost:3000 pnpm start:node
```

Node 协作广播仅支持一个应用进程，不支持多副本或 cluster；数据库 CAS 不能替代跨进程广播。数据位于工作目录的 `.data/db/sqlite.db` 和 `.data/blob/`。启动入口 `.output/server/start.mjs` 会先应用迁移；迁移失败时退出并停止启动。分发 `.output/` 后，在安装 Node.js 24 及以上版本的主机上，于其父目录执行 `PUBLIC_ORIGIN=http://localhost:3000 node .output/server/start.mjs`，不需要安装 Nuxt CLI。

## 备份和恢复

Node / Docker 停止写入后备份整个 `.data` 目录或卷，包含数据库、WAL 与快照；恢复时使用兼容版本，并确保运行用户可读写。源码方式的 `docker compose down`、GHCR 方式的 `docker compose -f compose.ghcr.yaml down` 均保留命名卷；添加 `-v` 会删除命名卷。

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
