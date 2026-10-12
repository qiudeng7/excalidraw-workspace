# 后端架构

后端使用 Nuxt 文件路由、NuxtHub 数据库与 Blob SDK。Node 使用 SQLite 和本地文件，Cloudflare Workers 使用 D1 和私有 R2。两端共用 schema、Drizzle 查询、权限校验和快照发布逻辑，部署配置负责选择存储目标。

## 请求与业务边界

`server/api/` 负责请求参数、业务编排和响应。`defineApiHandler()` 校验来源，默认要求登录，并统一返回 JSON 错误；公开账户接口显式设置 `{ public: true }`。身份只缓存于当前请求的 `event.context.currentUser`。

查询按资源组织在 `server/db/`，直接导入 `@nuxthub/db`。账户、会话、工作区、画布、导航、用户设置和快照元数据各有自己的模块。接口和业务函数显式传入用户 ID，查询条件约束资源归属。schema 中的 TypeScript 字段采用 camelCase，映射到已有的 snake_case SQL 字段。

请求配置通过 `useRuntimeConfig(event)` 读取，后台删除通过 `event.waitUntil()` 完成。`apiRequest(event)` 保留 Workers 的 DELETE 请求体；JSON 保存请求仍有 20 MB 上限。来源和代理配置见[部署说明](deployment.md)。

## 原子写入与快照

账户初始化、目录排序和导航更新使用 `db.batch()`。libSQL 和 D1 都按顺序原子执行批次；失败时回滚。带版本条件的批次在各次修改上校验归属和预期版本，最后递增版本，通过 `RETURNING` 判断是否成功。字段采用 Drizzle 具名选择，避免在 SQL 字符串中维护插入列的位置。[Drizzle Batch API](https://orm.drizzle.team/docs/sqlite/batch-api)

画布内容与素材库使用不可变 JSON 快照：先生成新的对象键并等待 `blob.put()` 成功，再以预期 revision 更新数据库引用。冲突或数据库失败时回收新对象，成功后后台删除旧对象。数据库与文件/R2 无法组成同一个事务，未完成发布的残留由维护任务回收。

`server/utils/snapshots.ts` 处理上述发布过程；`server/db/snapshots.ts` 处理引用与版本。对象存取直接使用 NuxtHub Blob SDK。每次写入新键，不覆盖已经发布的快照。

## 数据路径与迁移

Node 使用相对进程工作目录的 `.data/db/sqlite.db` 和 `.data/blob/`。Docker 工作目录是 `/app`，命名卷挂载于 `/app/.data`。Blob 路径显式配置为相对路径，构建产物可以搬到其他目录运行，无需修改 SDK 驱动。Cloudflare 使用 `DB`、`BLOB` binding，资源在 `wrangler.jsonc` 中配置。

修改 `server/db/schema.ts` 后运行 `pnpm db:generate`，提交生成的 SQL、schema 快照和 journal。SQL 位于 `server/db/migrations/sqlite/`，两端共用。既有 `0001` 至 `0004` 的 SQL 内容和名称保持不变，触发器及历史回填仍由这些迁移表达。

开发和部署都先迁移，再启动服务：

- `pnpm dev` 在启动 Nuxt 前运行 `pnpm db:migrate`。
- `pnpm start:node` 在启动 Node 构建产物前运行同一迁移命令。
- Docker Compose 的 `migrations` 服务运行 NuxtHub CLI，成功退出后才启动 `app`。
- D1 由 Wrangler 在部署前执行迁移，沿用 `d1_migrations`，避免重跑线上 SQL。

构建和 Nuxt 开发插件的自动迁移关闭，迁移失败由启动命令或 Compose 阻止服务启动。应用没有异步启动迁移插件、旧迁移表衔接逻辑或平台存储适配器。

旧 Node 安装使用一次性离线导入工具转换目录和迁移记录。应用不会自动读取旧路径；迁移命令发现 `.data/workspace.sqlite` 时退出，避免误建空库。具体操作见[部署说明](deployment.md#从旧-node-版本升级)。

## 孤立对象回收

`snapshots:cleanup` 是每小时执行的 Nitro 维护任务。Node 使用进程内调度，Workers 使用 `wrangler.jsonc` 中同样的 Cron Trigger。任务独立于用户 API 请求，仅处理超过 24 小时且没有数据库引用的 JSON 或旧临时文件。

每批最多查询 100 个对象键，两张引用表均有 `object_key` 索引；删除也分批执行。R2 按 SDK cursor 遍历。当前 NuxtHub 文件驱动一次枚举整个本地目录，因此 Node 的枚举内存开销仍随文件数增长，但数据库引用检查和删除按批执行。

## 验证

`pnpm test:backend` 使用真实 H3 文件处理器、隔离的 Drizzle SQLite 连接和 Blob SDK，验证权限、CAS、目录排序、会话、用户设置及持久化。测试中的模块替换用于隔离客户端，不替代平台接入验证。另有离线导入测试及实际 NuxtHub CLI 迁移失败阻止启动的测试。

两种构建必须串行。Node 和 Wrangler 的构建产物均需运行真实 HTTP 验收，检查初始化、并发目录操作、带请求体的 DELETE、含图片快照保存和重启后的读取。`scripts/smoke-navigation.mjs` 只接受本地回环地址与全新测试库。
