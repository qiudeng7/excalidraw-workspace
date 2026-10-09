# 后端模块与依赖注入

后端使用 Awilix 13 的 `awilix/browser` 入口，Node 和 Cloudflare 共用同一组业务模块。容器只出现在 `server/services/composition.ts`；模块通过具名依赖接口接收服务，不读取容器，不从模块全局变量读取用户。

## 请求如何进入业务模块

1. `server/api/[...path].ts` 选择平台存储，解析可信来源与客户端 IP。SQLite 连接由 Node 进程持有，D1/R2 绑定由 Workers 提供。
2. `handleApi()` 建立统一错误边界，再交给 composition root 创建本次请求的容器与 scope。
3. 路由器首先校验写请求来源，然后执行公开账户路由。其余请求经过认证，再按设置、导航、工作区、画布、素材库顺序分发。
4. 请求结束后释放 scope。外部存储用 `asValue()` 注册，没有请求级 disposer；释放 scope 不会关闭共享数据库，也不会取消已交给 `waitUntil()` 的后台清理。

容器启用 `PROXY` 与 `strict`。工厂函数解构具名依赖，压缩不依赖函数参数名推断；每个服务使用 scoped 生命周期。`Authentication` 在 scope 内缓存本次请求的身份查询，不在账户之间共享身份。严格模式帮助发现生命周期错误，业务权限仍由服务显式校验。

## 模块边界

| 模块 | 接口与职责 |
| --- | --- |
| `routing.ts`、`routes/` | `ApiRouter`、`RouteHandler`：路由分发、请求校验、HTTP 响应；每个路由依赖明确的 Repository 方法子集 |
| `auth.ts` | `Authentication`：会话、限流及当前用户，凭证加密算法独立在 `passwords.ts` |
| `access.ts` | `OwnedResources`：取得当前用户拥有的工作区/画布，隐藏其他用户资源 |
| `snapshots.ts` | `Snapshots`：不可变对象读取、写入、元数据 CAS、失败对象回收，返回类型化保存结果 |
| `http.ts` | HTTP 错误、JSON/body 大小限制、来源与预期账户校验、版本和名称校验 |
| `storage/ports.ts`、`repository.ts`、`rows.ts` | Repository 接口、SQL 实现、原始行解码；SQL driver 与原始行只在存储层使用 |
| `storage/node.ts`、`cloudflare.ts` | `SqlDriver`、`ObjectStore` 平台实现，分别对接 SQLite/文件和 D1/R2 |

原始 SQL 行是 `Record<string, unknown>`。Repository 在返回之前检查字段类型并构造 `User`、`Workspace`、`StoredCanvas` 等明确结果，业务层不会通过 `as Promise<领域类型>` 假装原始查询结果已验证。

路由可以返回 `undefined` 表示未匹配；这是内部协议，最终未知地址仍返回原有 JSON 错误。CAS、版本号、对象路径与对外路由保持原格式。保存先写不可变对象，再提交元数据 CAS：提交失败清理新对象，提交成功异步清理旧对象，不能交换顺序。

## 增加一个后端功能

先在 `shared/contracts.ts` 中定义客户端需要的请求和响应 DTO；存储行为在 Repository port 上定义明确输入输出，并在 SQL 实现中解码结果。随后增加具名服务接口或路由依赖接口，在 composition root 注册 scoped 工厂，并加入路由器分发顺序。服务只声明自己需要的接口方法，不能在服务内部调用 `container.resolve()`。

有权限的路由通过 `authentication.requireUser()` 获取当前用户。访问已有资源时调用 `ownedResources.workspace(id, user)` 或 `ownedResources.canvas(id, user)` 检查归属；管理员等角色权限另行显式检查。Repository 的写操作仍需传入 `user.id` 限定归属，不能只依赖入口完成登录认证。

运行 `pnpm test:backend` 检查认证、所有权、CAS 和持久化边界，再运行 `pnpm typecheck`。改变依赖或平台入口时，运行 `pnpm build` 和 `pnpm build:node` 验证 Workers 和 Node 构建。`tests/backend/dependency-injection.test.ts` 通过实际 API 请求检查并发用户隔离、请求结束后的共享存储可用性及容器异常的 HTTP 错误处理。
