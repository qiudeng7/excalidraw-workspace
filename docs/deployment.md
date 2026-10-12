# 部署与持久化

Cloudflare Workers 使用 D1 和私有 R2，Docker 使用 SQLite 和私有文件目录。两种部署拥有各自的数据；更换部署目标需要搬迁数据库及其引用的快照。

## Cloudflare Workers

在仓库根目录构建、迁移和部署：

```sh
pnpm build
pnpm db:migrate:remote
pnpm exec wrangler deploy
```

`wrangler.jsonc` 中的 `DB`、`BLOB` 分别绑定 D1 和 R2，Cron Trigger 每小时运行孤立快照回收。当前资源名为 `excalidraw-demo` 和 `excalidraw-demo-data`，Worker 名为 `excalidraw-workspace`。部署到自己的账户时，替换数据库 ID、资源名及 `vars.PUBLIC_ORIGIN`。

已有 D1 数据沿用 `d1_migrations`，新增迁移由 Wrangler 执行；不要使用另一套迁移记录重跑旧建表 SQL。R2 binding 改为 `BLOB`，仍指向原 bucket，对象键不变，不需要复制对象。`wrangler deploy` 本身不执行数据库迁移。

本地验证使用独立的模拟器数据：

```sh
pnpm build
pnpm db:migrate:local
pnpm dev:worker
```

打开 http://localhost:8787。更换 hostname 或端口时，在 Wrangler 参数中同步覆盖 `PUBLIC_ORIGIN`。本地 `.wrangler/` 数据与线上独立。

## Docker

全新安装在仓库根目录运行：

```sh
docker compose up --build -d
docker compose logs migrations app
```

已有旧版数据先执行下一节的升级步骤。Compose 的 `migrations` 服务使用构建阶段的 NuxtHub CLI 运行迁移，成功退出后才启动 `app`。迁移失败时修复错误并重新运行同一命令，应用不会带着半完成的 schema 启动。

两个服务均以 Node 普通用户运行。命名卷 `workspace-data` 挂载于 `/app/.data`，数据库位于 `db/sqlite.db`，快照位于 `blob/`。运行镜像仅包含 Node 产物；迁移镜像保留运行 NuxtHub CLI 所需的构建环境。

默认打开 http://localhost:8080，端口仅绑定回环地址。对外访问由反向代理提供 HTTPS，在 `.env` 中设置：

```dotenv
PORT=8080
PUBLIC_ORIGIN=https://draw.example.com
```

`PUBLIC_ORIGIN` 必须是完整 origin，包含协议且没有路径或通配符。它决定 CSRF 校验和 Cookie 的 Secure 属性。反向代理保留 Cookie、Origin 和请求头，不缓存 `/api/*`；需要按客户端 IP 限流时，设置 `TRUSTED_PROXY_IPS` 为可信代理连接 IP。

Node 也支持 `NUXT_PUBLIC_ORIGIN`、`NUXT_TRUSTED_PROXY_IPS`。变更 Compose 环境变量后重新运行 `docker compose up -d`。Node 数据路径固定相对工作目录；旧 `DATA_DIR`、`MIGRATIONS_DIR` 已由挂载位置和 NuxtHub 迁移入口取代。

## 从旧 Node 版本升级

首次切换需要停写并离线转换。先停止旧服务，备份完整旧数据目录，包括 `workspace.sqlite`、WAL 文件和 `objects/`。保留旧镜像和原始备份用于回退。

在安装依赖的项目目录中运行，两个参数使用绝对路径，目标目录必须尚不存在：

```sh
pnpm data:import --source /backup/workspace-old --target /backup/workspace-hub
```

工具通过 SQLite backup 复制数据库，将旧迁移记录转换成 NuxtHub 的 `_hub_migrations`，将 `objects/` 复制到 `blob/`，检查数据库完整性、外键及全部被引用快照是否存在。成功后目标包含 `db/sqlite.db` 与 `blob/`；源目录保持不变。检查失败不会发布部分目标，也不会合并或覆盖已有目标目录。工具不执行后续 schema 迁移。

对于 Docker，将导入目标目录的**内容**复制到一个新的空命名卷。下面使用 Node 基础镜像中的复制工具，并把所有权交给应用使用的 UID/GID 1000；目标卷非空时退出：

```sh
docker volume create workspace-hub-data
docker run --rm --user 0 --entrypoint sh \
  --mount type=bind,source=/backup/workspace-hub,target=/import,readonly \
  --mount type=volume,source=workspace-hub-data,target=/target \
  node:24-bookworm-slim \
  -c 'test -f /import/db/sqlite.db && test -d /import/blob && test -z "$(ls -A /target)" && cp -a /import/. /target/ && chown -R 1000:1000 /target'
docker run --rm --user 1000:1000 --entrypoint sh \
  --mount type=volume,source=workspace-hub-data,target=/target \
  node:24-bookworm-slim \
  -c 'test -r /target/db/sqlite.db && test -w /target/db/sqlite.db && test -w /target/db && test -d /target/blob && test -w /target/blob'
```

然后让两个 Compose 服务都挂载该卷，在本地 override 文件中指定卷名：

```yaml
# compose.migrated.yaml
volumes:
  workspace-data:
    external: true
    name: workspace-hub-data
```

`workspace-hub-data` 是你已填入导入数据的新卷。不要覆盖或删除旧卷。启动时指定 override：

```sh
docker compose -f compose.yaml -f compose.migrated.yaml up --build -d
```

迁移服务会应用剩余 SQL。随后验证原账户登录、工作区及画布数量、图片场景、素材库和用户设置，再重启应用验证持久化。回退时停止新服务，用旧镜像挂载保留的旧卷；升级后产生的新写入不会自动同步回旧卷。

本地 Node 开发同样先把旧 `.data/` 移到备份位置，将工具生成的新目录放为项目 `.data/`，再执行 `pnpm dev`。

## 单独运行 Node 构建产物

从项目根目录执行：

```sh
pnpm build:node
PUBLIC_ORIGIN=http://localhost:3000 pnpm start:node
```

启动命令需要已安装的项目依赖和 schema 迁移文件，并先运行 NuxtHub CLI。单独复制 `.output/` 时，应由部署流程事先迁移相同工作目录下的 `.data/db/sqlite.db`，再执行 `node .output/server/index.mjs`。直接运行 Node 产物不会应用迁移。

## 备份和恢复

停止写入后备份整个 `.data` 卷，包含数据库、WAL 文件与快照。恢复时使用兼容版本，并保证 Node 用户可读写。Docker 的 `down` 保留卷，`down -v` 会删除项目的命名卷。

Cloudflare 升级前备份 D1 和被引用的 R2 对象。代码回滚使用原资源绑定；应用迁移前检查它是否兼容旧代码。
