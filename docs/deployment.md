# 部署与持久化

应用有两个运行目标：Cloudflare Workers 使用 D1 和私有 R2；Docker 使用 SQLite 和私有文件目录。它们运行同一套页面、账户和保存业务，但拥有各自的数据。画布只在浏览器渲染，服务端不运行 React 编辑器。

## Cloudflare Workers

在仓库根目录运行 `pnpm build`，Nuxt/Nitro 生成 `.output/server/index.mjs` 和 `.output/public/`。`wrangler.jsonc` 引用这两个目录，以及现有 `DB`、`DATA` binding。

部署到自己的 Cloudflare 账户时，先创建数据库和 bucket，替换配置中的数据库 ID 与资源名，并把 `vars.PUBLIC_ORIGIN` 改为实际访问的完整 origin，例如 `https://draw.example.com`。它必须包含协议，不能包含路径、多个域名或通配符。当前仓库内的 ID 指向已有线上应用。

```sh
pnpm db:migrate:remote
pnpm build
pnpm exec wrangler deploy
```

当前在线应用使用 `excalidraw-workspace` Worker，地址为 `https://excalidraw-workspace.qiudeng.workers.dev`。D1 仍使用 `excalidraw-demo`，R2 仍使用 `excalidraw-demo-data`，账户和画布数据保持原有位置。Cookie 绑定访问域名，更换域名后需重新登录。更新之前备份 D1 与 R2 引用对象；代码回滚仍使用原绑定，新增 schema 应保持向后兼容。

本地验证 Workers：

```sh
pnpm build
pnpm db:migrate:local
pnpm dev:worker
```

打开 http://localhost:8787。本地脚本覆盖 `PUBLIC_ORIGIN` 为这个地址；改用其他 hostname 或端口时也需同步修改 origin。不要把本地覆盖写入生产配置。

## Docker

仓库提供多阶段 `Dockerfile` 和 `compose.yaml`，运行镜像只有 Node 服务产物与迁移文件，使用 Node 24、普通用户和单实例。

```sh
docker compose up --build -d
docker compose logs -f app
```

默认只在本机 http://localhost:8080 接收请求。首次 API 请求初始化数据库并应用迁移，然后页面引导创建管理员。重启与重建保留命名卷；删除命名卷会删除账户、画布和素材库。

对外访问时由反向代理提供 HTTPS，把 `.env` 的 `PUBLIC_ORIGIN` 改成真实域名。反向代理应保留 Cookie、Origin 和请求头，不缓存 `/api/*`。变更环境变量后运行 `docker compose up -d` 重建容器配置。

| 环境变量 | 用途 |
| --- | --- |
| `PUBLIC_ORIGIN` | 可信访问 origin，用于 CSRF 校验和 Secure cookie；生产必须配置。 |
| `DATA_DIR` | SQLite 和私有快照目录；Docker 默认 `/data`，本地 Node 默认 `.data/`。 |
| `MIGRATIONS_DIR` | SQL 迁移目录；Docker 默认 `/app/migrations`。 |
| `TRUSTED_PROXY_IPS` | 以逗号分隔的可信代理 IP，默认空。仅来自这些连接的转发 IP 会参与登录限流；不要信任任意客户端提供的 `X-Forwarded-For`。 |
| `PORT` | Compose 映射的本机端口，默认 8080；它不改变 `PUBLIC_ORIGIN`。 |

代理部署时，根据实际连接 IP 配置 `TRUSTED_PROXY_IPS`。没有可信代理配置时，限流使用真实 TCP 对端；因此经过代理的用户可能共享同一个 IP 限额。

## 备份和恢复

SQLite 与 JSON 快照必须一起备份。在停止写入后停掉容器，将整个 `/data` 卷保存，再启动容器。不要只复制 `workspace.sqlite`：WAL 文件与被数据库引用的快照同样属于数据。

恢复时把完整数据放到新卷并保证 Node 用户可读写，再用相同版本或兼容迁移的镜像启动。首次启动不会清空已存在的数据库。Docker 默认独立使用；从线上搬数据需停写并迁移数据库及全部引用对象，不能只切换运行模式就共享 D1/R2。

快照使用不可变文件或对象键，元数据通过版本号切换引用。版本冲突和删除操作会清理对应对象；后台清理只处理超过 24 小时、且未被数据库引用的残留，避免删除正在提交的数据。
