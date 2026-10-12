# 后端架构

后端采用 Nuxt 文件路由：接口直接在 `server/api/` 中完成参数处理和业务编排，共用逻辑放在 `server/utils/`。数据库连接和对象存储由 Nitro 提供，Repository 负责 SQL、事务和数据解码。

## 一次请求经过哪里

以 `PUT /api/canvases/:id` 保存画布为例：

1. `server/plugins/storage.ts` 挂载 Node 文件系统或 Workers R2 对象驱动。Node 数据库连接按需初始化，服务退出时关闭。
2. 插件通过 Nitro 的 `request` hook 在 `event.context.repository` 放置业务数据库访问函数。同一请求复用初始化 Promise；初始化异常由接口的错误边界处理。
3. Nuxt 根据文件名选择 `server/api/canvases/[id].put.ts`。共用的 `defineApiHandler()` 校验来源、默认要求登录，并将异常转换为现有 JSON 错误格式。
4. 接口文件解析参数和请求体，检查画布归属，再调用共用的 `saveSnapshot()` 写快照并提交元数据。

认证使用 `requireUser(event)`。首次查询的 Promise 存在当前 `event.context` 中，同一请求的入口校验和处理逻辑复用身份查询，不同请求独立查询。数据库连接可以由进程共享，用户身份只存在于请求事件中。请求相关信息直接使用 Nitro/H3 的 `event`，没有额外的 `BackendContext` 或 DI 容器。显式传递 `event`，无需启用实验性的 `asyncContext`。

来源配置通过 `useRuntimeConfig(event)` 读取，后台任务交给 `event.waitUntil()`，对象存储通过 `useStorage("objects")` 访问。`event.context` 只补充项目需要的 Repository 访问函数和当前用户等字段。Repository 函数按需取得原生 `useDatabase()` 连接，保留项目的 SQL 事务与行解码规则。Nitro 提供请求上下文和生命周期，业务代码使用这些机制。[原生工具](https://v2.nitro.build/guide/utils)、[插件与生命周期](https://v2.nitro.build/guide/plugins)见官方文档。

公开账户接口显式传入 `{ public: true }`，其余接口默认要求登录。`server/api/[...path].ts` 返回未知接口的 JSON 错误；设置、导航等接口的方法兜底文件保留 JSON 405。兜底同样经过来源和认证检查，来源合法但未登录的请求先返回 401。

## 哪些逻辑需要复用

接口专用的参数读取、验证与响应直接写在 API 文件里。只有多个接口共同使用或有独立数据一致性规则的逻辑才提取为函数：

| 位置                                      | 职责                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| `server/utils/api.ts`、`request.ts`       | 默认认证、来源校验、统一错误格式、路由参数和安全相关请求读取 |
| `server/utils/auth.ts`、`accounts.ts`     | 当前用户、会话、限流，以及初始化/注册共用的账户创建流程      |
| `server/utils/access.ts`                  | 根据当前用户查找工作区或画布，隐藏其他用户的资源             |
| `server/utils/snapshots.ts`               | 不可变对象读取、保存、元数据版本冲突检查和失败回收           |
| `server/utils/http.ts`、`userSettings.ts` | 请求体大小、JSON、名称、版本、预期账户和设置格式校验         |
| `server/storage/`                         | Repository、SQL 行解码及 Node/Cloudflare 存储适配            |

例如，画布保存接口先取得 `await event.context.repository()`，再调用 `requireCanvas(repository, id, user)` 检查归属。`saveSnapshot(event, user, ...)` 通过原生存储接口写入快照；`runBackground(event, promise)` 调用 `event.waitUntil()` 并记录后台任务异常。

## 原生存储与业务规则的边界

Nitro 配置启用 `experimental.database`，Node 使用 DB0 的 `node-sqlite` connector，Workers 使用 `cloudflare-d1` connector。数据库 API 在 Nitro 2 中仍属实验能力。Node 的薄适配器在服务启动时读取 `DATA_DIR`，保留 `workspace.sqlite` 的原位置；SQL 迁移仍从 `MIGRATIONS_DIR` 读取，默认是 `migrations/`。Workers 继续使用现有 D1 迁移流程。

快照挂载在 `objects` 命名空间，底层使用 Unstorage 的 `fs-lite` 或 `cloudflare-r2-binding` 驱动。适配器保留已有的斜杠对象路径，避免 Unstorage 的冒号键规范改变旧 R2 对象地址。R2 列表保留分页和每页自带的上传时间，避免逐对象发起额外查询；原生驱动的键列表也补充完整分页，删除继续使用 R2 批量操作，避免逐键请求。Node 写入保留临时文件加 rename 的原子发布。孤立对象回收使用底层修改时间，并保留宽限期；无法取得时间时不回收。Node 对象目录仍为 `DATA_DIR/objects/`，R2 仍使用 `DATA` 绑定，无需迁移已有快照。

服务端来源和可信代理配置分别使用 `runtimeConfig.publicOrigin` 与 `runtimeConfig.trustedProxyIps`，运行时可通过 `NUXT_PUBLIC_ORIGIN`、`NUXT_TRUSTED_PROXY_IPS` 覆盖。现有 `PUBLIC_ORIGIN`（包含 Workers 绑定）和 `TRUSTED_PROXY_IPS` 保留为兼容回退，原生配置优先。生产环境必须配置可信来源；请求的 Host 和转发头不能决定 CSRF 来源或 Cookie 的 Secure 属性。Node 只接受已配置可信代理传来的 IP 链，Workers 使用平台的 `cf-connecting-ip`。

`useStorage()` 是对象存取接口，不替代 SQL 事务。Repository 的事务继续使用 SQLite 的 `BEGIN IMMEDIATE` 或 D1 的原子 `batch()`。保存规则仍是：先写不可变快照，再以版本号进行元数据比较并更新（CAS）；提交失败回收新对象，提交成功通过 `event.waitUntil()` 回收旧对象。不能交换写对象和提交元数据的顺序。

## 增加一个接口

在 `server/api/` 中增加文件，例如 `workspaces/index.get.ts` 声明 `GET /api/workspaces`：

```ts
import { defineApiHandler } from "../../utils/api";
import { requireUser } from "../../utils/auth";
import { json } from "../../utils/http";

export default defineApiHandler(async (event) => {
  const repository = await event.context.repository();
  const user = await requireUser(event);

  return json({ workspaces: await repository.workspaces(user.id) });
});
```

需要 DTO 时在 `shared/contracts.ts` 定义；有存储需求时增加 Repository 方法并在返回之前解码原始 SQL 行。访问已有资源仍要检查归属，写入仍须传入 `user.id`，管理员权限也需显式检查。简单接口无需额外创建 service 或依赖接口。

`defineApiHandler()` 是项目保留的共用 HTTP 边界，内部调用 Nuxt 使用的 H3 handler，负责客户端已有的 `{ error: { code, message } }` 格式和默认访问策略。Nitro 2 在 Workers 中只缓冲 POST、PUT、PATCH；`apiRequest(event)` 对带 JSON 的 DELETE 使用原始 Worker Request，其他方法使用 H3 重建的请求。`body()` 保留 20 MB 上限和 JSON 对象校验。

运行 `pnpm test:backend`、`pnpm typecheck`、`pnpm lint` 检查请求身份隔离、权限、CAS、持久化和代码类型。后端测试通过 H3 加载真实文件路由；平台插件、原生工具和绑定还需用构建后的 Node 服务及本地 Wrangler 请求验证。`pnpm build:node` 和 `pnpm build` 必须串行运行。

## 本地验证平台接入

Node 验证先运行 `pnpm build:node`，再在仓库根目录启动构建产物，使用独立测试目录：

```sh
DATA_DIR=/tmp/workspace-node-check PUBLIC_ORIGIN=http://localhost:4987 NITRO_PORT=4987 node .output/server/index.mjs
```

另一个终端请求 `curl http://localhost:4987/api/bootstrap`，应得到含 `needsSetup` 的 JSON，响应应有 `Cache-Control: no-store`；未登录访问 `/api/workspaces` 应得到 JSON 401。首次测试目录可在浏览器完成初始化，再保存含图片的画布和素材库、修改用户设置。停止并重启服务后，会话、画布、素材库和设置应可继续读取。

Workers 验证使用本地 D1/R2，先运行 `pnpm build`，再准备独立模拟器数据，避免使用已有的本地开发库：

```sh
pnpm exec wrangler d1 migrations apply DB --local --persist-to /tmp/workspace-worker-check
pnpm exec wrangler dev --local --persist-to /tmp/workspace-worker-check --port 4988 --var PUBLIC_ORIGIN:http://localhost:4988
```

绑定由 `wrangler.jsonc` 中的 `DB` 和 `DATA` 定义。按 Node 的相同步骤验证 `http://localhost:4988`；额外验证带 `catalogRevision` JSON 的画布 DELETE，旧版本应返回 JSON 409，正确版本应成功。DELETE 请求需携带当前登录 Cookie、`Origin: http://localhost:4988`、`X-Requested-With: excalidraw-demo` 和 `Content-Type: application/json`；可在已登录的同源页面中用 `fetch()` 发起。构建后 Node 与 Wrangler 的请求验证用于检查存储插件、原生工具和平台绑定，不能用 H3 测试替代，也不等于生产部署验证。
