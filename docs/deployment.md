# 部署

命令在仓库根目录执行。源码安装与本地 Worker 调试见 [README](../README.md#本地启动)，运行验证见[开发验证](development/testing.md)。首次部署后打开页面创建管理员。

## Docker

```sh
docker compose up --build -d
docker compose logs migrations app
```

打开 http://localhost:8080。数据库和快照保存在命名卷 `workspace-data`，挂载到 `/app/.data`；迁移成功后应用才启动。迁移失败时修复错误后重新执行启动命令。

对外提供服务时，由反向代理提供 HTTPS，并在 `.env` 设置：

```dotenv
PORT=8080
PUBLIC_ORIGIN=https://draw.example.com
```

端口只绑定回环地址。`PUBLIC_ORIGIN` 填浏览器实际访问的完整 origin，不含路径；仅修改本地端口时，也须同步修改该值。代理须保留 Cookie、Origin 和请求头，不缓存 `/api/*`。按客户端 IP 限流时，将代理连接 IP 填入 `TRUSTED_PROXY_IPS`。修改环境变量后执行 `docker compose up -d`。

## Cloudflare Workers

首次部署到自己的账户，按 [README](../README.md#部署到-cloudflare) 创建 D1 和 R2，并在 [wrangler.jsonc](../wrangler.jsonc) 设置数据库 ID、资源名和 `PUBLIC_ORIGIN`。仓库中的绑定指向现有线上资源，须替换为自己的资源。

```sh
pnpm run deploy
```

该命令依次构建、迁移远程 D1、部署 Worker。D1 与 R2 的 binding 分别为 `DB`、`BLOB`；已有数据库沿用 `d1_migrations`，不要更换迁移记录重跑旧 SQL。

## 单独运行 Node

安装项目依赖后执行：

```sh
pnpm build:node
PUBLIC_ORIGIN=http://localhost:3000 pnpm start:node
```

数据位于工作目录的 `.data/db/sqlite.db` 和 `.data/blob/`。启动命令先应用迁移；若仅分发 `.output/`，部署流程须先迁移相同数据目录，再执行 `node .output/server/index.mjs`。

## 备份和恢复

Node / Docker 停止写入后备份整个 `.data` 目录或卷，包含数据库、WAL 与快照；恢复时使用兼容版本，并确保运行用户可读写。`docker compose down` 保留命名卷，`down -v` 会删除命名卷。

Cloudflare 备份 D1 及其引用的 R2 对象。两种部署的数据独立，切换目标须一起搬迁数据库和快照；代码回滚前确认数据库迁移与旧代码兼容。
