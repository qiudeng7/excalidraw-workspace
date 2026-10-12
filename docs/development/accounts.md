# 账户与访问

[返回开发者指南](readme.md)

用户通过邮箱和密码建立会话；管理员额外控制注册开放状态。账户表单在 [AccountGate.vue](../../src/components/AccountGate.vue)，登录后的生命周期由 [useAccountSession.ts](../../src/composables/useAccountSession.ts) 编排，HTTP 适配在 [accountApi.ts](../../src/lib/accountApi.ts)。

## 初始化管理员

首次打开服务时，前端调用 [GET /api/bootstrap](../../server/api/bootstrap.get.ts)。若 `needsSetup=true`，显示初始化表单，并通过 [POST /api/setup](../../server/api/setup.post.ts) 创建管理员。

后端沿 [registerAccount()](../../server/utils/accounts.ts) → [createAccount()](../../server/db/accounts.ts) 创建账户、默认工作空间、首张画布、个人素材库和导航记录，再通过 [createSession()](../../server/utils/auth.ts) 设置会话 Cookie。初始资源在数据库批次中一起创建；唯一管理员约束阻止重复初始化。账户创建与后续会话写入属于两个步骤。

成功后走与登录相同的账户加载流程。初始化与普通注册共用凭证校验，邮箱规范化为小写，密码为 12–256 个字符。

## 注册与登录

普通用户通过 [POST /api/register](../../server/api/register.post.ts) 注册，通过 [POST /api/login](../../server/api/login.post.ts) 登录。注册创建与初始化相同的一组个人资源；管理员尚未创建或已关闭注册时拒绝普通注册。登录校验密码并创建会话，不重新创建工作空间。

表单拿到用户后调用 `useAccountSession.authenticated()`：刷新启动状态 → [加载账户设置](user-settings.md#加载设置) → [恢复工作目录](workspaces.md#恢复工作目录)。注册失败、凭证错误和请求限流通过统一 JSON 错误反馈给表单。

## 恢复登录状态

刷新页面时，`useAccountSession.initialize()` 先调用 [GET /api/bootstrap](../../server/api/bootstrap.get.ts)。服务已初始化时，再调用 [GET /api/session](../../server/api/session.get.ts)；无有效会话返回 `user: null`，有会话则加载账户设置和工作目录。

会话校验在 [auth.ts](../../server/utils/auth.ts)，数据库只存令牌摘要。当前用户只缓存在本次请求的 `event.context`，避免不同请求共享身份。Cookie 与来源校验的共用规则见[请求与权限边界](architecture.md#请求与权限边界)。

## 退出登录

`useAccountSession.logout()` 先等待编辑器保存画布和素材库，再等待账户设置保存；成功后才调用 [POST /api/logout](../../server/api/logout.post.ts)，删除会话并清除 Cookie。前端随后销毁设置资源、清空当前目录和文档、重新读取启动状态。

保存失败会中止退出并保留页面。修改退出入口时，须继续通过该控制器，确保未保存内容和旧账户请求得到处理。

## 管理注册权限

管理员在页面切换注册开关，通过 [PATCH /api/admin/settings](../../server/api/admin/settings.patch.ts) 提交 `{ registrationEnabled }`。后端验证管理员身份和布尔值，更新设置并返回实际状态；失败时页面保持原状态。关闭注册不影响已有账户登录。

后端还提供 [GET /api/admin/settings](../../server/api/admin/settings.get.ts) 供管理员读取；当前页面从 [GET /api/bootstrap](../../server/api/bootstrap.get.ts) 取得初始开关值。

## 验证入口

[node-storage.test.ts](../../tests/backend/node-storage.test.ts) 覆盖账户初始化、注册、会话及持久化，[request-context.test.ts](../../tests/backend/request-context.test.ts) 检查请求身份隔离，[user-settings-resource.test.ts](../../tests/backend/user-settings-resource.test.ts) 检查设置资源销毁与旧请求取消。浏览器中检查首次初始化、注册关闭、登录失败、刷新恢复，以及保存失败时退出是否被阻止。
