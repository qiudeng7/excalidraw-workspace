# 账户与访问

[返回目录](../../README.md#目录)

用户通过邮箱和密码（本地账号）或外部 OIDC 身份提供方建立会话，前者由 `AUTH_LOCAL` 开关控制，后者由管理员在数据库中维护的身份源决定；管理员额外控制注册开放状态。账户表单在 [AccountGate.vue](../../src/components/AccountGate.vue)，登录后的生命周期由 [useAccountSession.ts](../../src/composables/useAccountSession.ts) 编排，HTTP 适配在 [accountApi.ts](../../src/lib/accountApi.ts)。

## 初始化管理员

首次打开服务时，前端调用 [GET /api/bootstrap](../../server/api/bootstrap.get.ts)。若 `needsSetup=true`，显示初始化表单，并通过 [POST /api/setup](../../server/api/setup.post.ts) 创建管理员。

后端沿 [registerAccount()](../../server/utils/accounts.ts) → [createAccount()](../../server/db/accounts.ts) 创建账户、默认工作空间、首张画布、个人素材库和导航记录，再通过 [createSession()](../../server/utils/auth.ts) 设置会话 Cookie。初始资源在数据库批次中一起创建；唯一管理员约束阻止重复初始化。账户创建与后续会话写入属于两个步骤。

成功后走与登录相同的账户加载流程。初始化与普通注册共用凭证校验，邮箱规范化为小写，密码为 12–256 个字符。

## 注册与登录

打开[在线应用](https://excalidraw-workspace.qiudeng.workers.dev/)后注册或登录即可使用。邮箱只作为登录名，无需邮件验证。

普通用户通过 [POST /api/register](../../server/api/register.post.ts) 注册，通过 [POST /api/login](../../server/api/login.post.ts) 登录。注册创建与初始化相同的一组个人资源；管理员尚未创建或已关闭注册时拒绝普通注册。登录校验密码并创建会话，不重新创建工作空间。

登录、初始化和注册在写入会话时，都由 [createSession()](../../server/db/sessions.ts) 在同一条条件插入语句中核对账户当前密码摘要与本次已接受的摘要。若改密先完成，旧凭据请求随后写入会话时返回 `401 INVALID_CREDENTIALS`，不创建会话，也不设置 Cookie；若该请求的会话先写入，改密批次会将它作为其他会话撤销，防止旧凭据请求晚到后恢复访问。

表单拿到用户后调用 `useAccountSession.authenticated()`：刷新启动状态 → [加载账户设置](user-settings.md#加载设置) → [恢复工作目录](workspaces.md#恢复工作目录)。注册失败、凭证错误和请求限流通过统一 JSON 错误反馈给表单。

## 恢复登录状态

刷新页面时，`useAccountSession.initialize()` 先调用 [GET /api/bootstrap](../../server/api/bootstrap.get.ts)。服务已初始化时，再调用 [GET /api/session](../../server/api/session.get.ts)；无有效会话返回 `user: null`，有会话则加载账户设置和工作目录。

会话校验在 [auth.ts](../../server/utils/auth.ts)，数据库只存令牌摘要。当前用户只缓存在本次请求的 `event.context`，避免不同请求共享身份。Cookie 与来源校验的共用规则见[请求与权限边界](architecture.md#请求与权限边界)。

## 退出登录

`useAccountSession.logout()` 先等待编辑器保存画布和素材库，再等待账户设置保存；成功后才调用 [POST /api/logout](../../server/api/logout.post.ts)，删除会话并清除 Cookie。前端随后销毁设置资源、清空当前目录和文档、重新读取启动状态。

保存失败会中止退出并保留页面。修改退出入口时，须继续通过该控制器，确保未保存内容和旧账户请求得到处理。

## 修改密码

用户从工作空间侧边栏底部的“设置”进入“账号”。[AccountPasswordForm.vue](../../src/components/AccountPasswordForm.vue) 要求原密码、新密码及确认新密码；确认不一致时不提交。新密码需为 12–256 个字符，且不能与原密码相同。

表单通过 [PUT /api/account/password](../../server/api/account/password.put.ts) 提交 `{ currentPassword, newPassword }`。请求携带 `X-Account-Owner` 校验页面账户与会话是否仍一致，后端按当前登录账户验证原密码，使用 PBKDF2 生成新摘要，再由 [changeAccountPassword()](../../server/db/accounts.ts) 在同一数据库批次中按已验证的旧摘要更新密码并删除其他会话。当前登录会话保留，其他登录会话失效，需要使用新密码重新登录；并发修改不能覆盖已更改的密码。密码验证尝试按账户限流，每 15 分钟时间桶最多 10 次。

原密码错误返回 `403 INVALID_CURRENT_PASSWORD`，密码已被并发更改返回 `409 PASSWORD_CHANGED`，达到尝试上限返回 `429 RATE_LIMITED`。表单展示错误；成功后清空密码字段并显示确认。[account-password.test.ts](../../tests/integration/account-password.test.ts) 覆盖原密码校验、会话失效范围、并发修改、限流，以及登录、初始化和注册接受旧密码后延迟写入会话与改密的竞争。

## 管理注册权限

“系统设置”仅对管理员显示，位于设置面板左侧导航下方。管理员在“设置 → 系统设置”切换注册开关，通过 [PATCH /api/admin/settings](../../server/api/admin/settings.patch.ts) 提交 `{ registrationEnabled }`。后端验证管理员身份和布尔值，更新设置并返回实际状态；失败时页面保持原状态。关闭注册不影响已有账户登录。

后端还提供 [GET /api/admin/settings](../../server/api/admin/settings.get.ts) 供管理员读取；当前页面从 [GET /api/bootstrap](../../server/api/bootstrap.get.ts) 取得初始开关值。

## 账号方式开关

本地账号由部署环境变量 `AUTH_LOCAL` 控制，规则集中在 [auth-config.ts](../../server/utils/auth-config.ts) 的纯函数 `parseAuthConfig()`；OIDC 身份源不再读取环境变量，由管理员在界面里维护并保存在数据库 `oidc_providers` 表（结构见 [schema.ts](../../server/db/schema.ts)）。

| 变量         | 默认   | 说明                             |
| ------------ | ------ | -------------------------------- |
| `AUTH_LOCAL` | `true` | 本地注册、登录、初始化与修改密码 |

布尔值只接受 `true/false/1/0`；配置无效时不降级：Node 由 [auth-config 插件](../../server/plugins/auth-config.ts) 在启动时退出，Workers 由 [defineApiHandler()](../../server/utils/api.ts) 在每个 API 请求返回 `500 CONFIGURATION_INVALID`。`AUTH_LOCAL=false` 时登录、注册、初始化与修改密码接口返回 `403 AUTH_METHOD_DISABLED`，能否进入完全取决于表中是否有已启用的身份源。

[GET /api/bootstrap](../../server/api/bootstrap.get.ts) 返回 `authMethods: { local: boolean, oidc: Array<{ id, type, name, iconUrl }> }`，`oidc` 只包含已启用的身份源；没有任何身份源时是空数组，登录页不出现 OIDC 入口，也不会报配置错误。[AccountGate.vue](../../src/components/AccountGate.vue) 按数组为每个身份源渲染一个“使用 {name} 登录”按钮，设置面板在本地账号关闭时隐藏修改密码。

**首次部署必须保持本地账号开启**，通过初始化表单创建管理员；之后才可以关闭本地账号。`AUTH_LOCAL=false` 且尚无管理员时，bootstrap 仍返回 `needsSetup=true`，但初始化接口返回 `403 AUTH_METHOD_DISABLED`，需要临时恢复 `AUTH_LOCAL=true`。

## 管理登录方式

管理员在“设置 → 系统设置 → 登录方式”维护身份源，表格列出图标、名称、类型、issuer 与启用开关，新建/编辑对话框负责其余字段。接口都要求管理员会话，实现在 [server/api/admin/oidc-providers/](../../server/api/admin/oidc-providers/)：

| 接口                                      | 说明                                                     |
| ----------------------------------------- | -------------------------------------------------------- |
| `GET /api/admin/oidc-providers`           | 列表；按约定以明文返回 `clientSecret`                    |
| `POST /api/admin/oidc-providers`          | 新建；`id` 由前端生成（`crypto.randomUUID()`）后提交     |
| `PATCH /api/admin/oidc-providers/{id}`    | 修改；`type` 创建后不可改                                |
| `DELETE /api/admin/oidc-providers/{id}`   | 删除；已映射账户保留                                     |
| `PUT /api/admin/oidc-providers/{id}/icon` | 上传 custom 图标，接受 png/svg/webp 的 data URL，≤256 KB |
| `GET /api/auth/oidc/{providerId}/icon`    | 公开读取上传的图标                                       |

身份源字段保存在 `oidc_providers`：`id`、`type`、`name`、`issuer`、`client_id`、`client_secret`（**明文存储**，换取令牌需要原始值）、`scopes`（默认 `openid profile email`）、`icon`（上传图标的对象键，预设为空）、`enabled`、`auto_register`、`created_at`、`updated_at`。唯一约束是 `(type, issuer, client_id)`，因此微软多租户可以让多行都填 `common`。图标复用现有对象存储（Node 写 `.data/blob`，Workers 写 R2），键为 `oidc-providers/{id}/icon.{png|svg|webp}`；读取时带 `sandbox` CSP，直接打开上传的 SVG 也不会执行脚本。

| `type`      | 默认名称   | 默认 issuer（可改）                             | 图标       |
| ----------- | ---------- | ----------------------------------------------- | ---------- |
| `microsoft` | Microsoft  | `https://login.microsoftonline.com/common/v2.0` | 内置       |
| `gitlab`    | GitLab     | `https://gitlab.com`，自建实例填实例根地址      | 内置       |
| `google`    | Google     | `https://accounts.google.com`                   | 内置       |
| `custom`    | 管理员填写 | 管理员填写                                      | 管理员上传 |

预设类型的图标是前端内置资源（`public/oidc/*.svg`），bootstrap 的 `iconUrl` 直接返回该路径；custom 上传后返回 `/api/auth/oidc/{id}/icon`。GitHub 不是 OIDC，不在预设里。

## OIDC 登录

应用作为 OIDC 依赖方，使用授权码与 PKCE（S256），实现在 [oidc.ts](../../server/utils/oidc.ts)：

1. 登录入口是 [GET /api/auth/oidc/{providerId}/start](../../server/api/auth/oidc/[providerId]/start.get.ts)。身份源不存在或未启用时直接回到 `/?authError=oidc_disabled`，不暴露配置差异；启用时服务端读取该 issuer 的 discovery（按 issuer 缓存 1 小时），生成 state、nonce 与 code verifier，写入 10 分钟有效的 HttpOnly 流程 Cookie 后重定向到身份提供方。流程 Cookie 的值是 `providerId.state.verifier.nonce`，路径取公开回调地址所在目录（`/api/auth/oidc/{id}`），不同身份源的流程互不影响。
2. 身份提供方回到 [GET /api/auth/oidc/{providerId}/callback](../../server/api/auth/oidc/[providerId]/callback.get.ts)。服务端核对流程 Cookie 的 `providerId` 与路由参数一致、state 匹配，用授权码换取令牌，以 JWKS 验证 `id_token`（RS256/ES256，校验 iss、aud、exp 与 nonce），流程 Cookie 无论成功与否都立即作废。
3. [oidc-accounts.ts](../../server/utils/oidc-accounts.ts) 用 `id_token` 的**实际 issuer** 与 `sub` 查 `(provider, issuer, subject)` 唯一索引，首次登录时创建普通用户和与注册相同的一组个人资源；邮箱与已有账户冲突时追加稳定后缀。`auto_register=false` 且没有映射账户时回到 `/?authError=oidc_not_registered`，不创建账户。
4. 成功后通过 [startSession()](../../server/utils/auth.ts) 写入与本地登录相同的会话 Cookie，并固定重定向到 `/`。失败时同样回到 `/` 并附带 `authError` 代码，详细原因只写服务端日志。

微软多租户端点的 discovery issuer 是 `https://login.microsoftonline.com/{tenantid}/v2.0` 模板，`id_token` 的 `iss` 带实际租户。身份源 `type=microsoft` 且配置的 issuer 是 `common`、`organizations`、`consumers` 或 `{tenantid}` 模板时，校验要求 `iss` 等于 `https://login.microsoftonline.com/{tid}/v2.0`，`tid` 取自 `id_token` 的 `tid` 声明，账户映射保存这个带租户的 `iss`；配置成具体租户 issuer 或其它类型时，`iss` 必须与配置完全一致。

**OIDC 账户一律是普通用户**：管理员只能由本地账号初始化产生，不再有“系统尚无管理员时首个 OIDC 账户成为管理员”的规则。OIDC 账户的密码摘要为不可验证的占位值，不能用密码登录或修改密码；同一邮箱的本地账户与 OIDC 账户是两个独立账户，不自动合并。删除身份源不会删除已映射账户，但这些账户之后只能通过重新创建同 issuer 的身份源登录。

回调地址是 `PUBLIC_ORIGIN` 加 `/api/auth/oidc/{providerId}/callback`。新建对话框在打开时就生成 `id` 并显示该地址，可直接复制到身份提供方登记。经代理前缀部署时回调地址不含前端前缀，宿主需要额外把 `/api/auth/oidc/*` 转发到应用。

## 验证入口

[node-storage.test.ts](../../tests/integration/node-storage.test.ts) 覆盖账户初始化、注册、会话及持久化，[request-context.test.ts](../../tests/integration/request-context.test.ts) 检查请求身份隔离，[user-settings-resource.test.ts](../../tests/unit/user-settings-resource.test.ts) 检查设置资源销毁与旧请求取消。[auth-config.test.ts](../../tests/unit/auth-config.test.ts)、[oidc-flow.test.ts](../../tests/unit/oidc-flow.test.ts) 与 [oidc-issuer.test.ts](../../tests/unit/oidc-issuer.test.ts) 覆盖环境开关、流程 Cookie 与 issuer 判定；[oidc-auth.test.ts](../../tests/integration/oidc-auth.test.ts) 以本地密钥模拟多个身份提供方，覆盖分别登录、微软租户 iss、未启用拒绝、`auto_register=false` 与流程 Cookie 不匹配；[oidc-providers.test.ts](../../tests/integration/oidc-providers.test.ts) 覆盖管理接口权限、唯一冲突、图标上传与读取，以及 bootstrap 只返回启用项。浏览器中检查首次初始化、注册关闭、登录失败、刷新恢复，以及保存失败时退出是否被阻止。
