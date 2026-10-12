# 账户设置

[返回开发者指南](readme.md)

“flag”菜单中的绘图功能、采样倍率与渲染开关按账户保存；这些设置独立于画布场景和撤销历史。菜单接入在 [CanvasFlagsMenu.ts](../../src/components/CanvasFlagsMenu.ts)，保存与冲突状态在 [userSettings.ts](../../src/lib/userSettings.ts)，完整类型与默认值在 [shared/contracts.ts](../../shared/contracts.ts)。

## 加载设置

[账户加载](accounts.md#恢复登录状态)时，`useAccountSession` 为当前账户创建设置资源，通过 [GET /api/user-settings](../../server/api/user-settings.get.ts) 读取。请求携带 `X-Settings-Owner`；后端比较该值与登录用户，防止旧页面请求操作新账户。

没有云端记录时，返回默认设置、`revision: 0`、`configured: false`。读取失败时按默认值展示，但设置控件保持只读；重试读取成功后才允许修改，避免用默认值覆盖未读到的云端配置。

用户可通过菜单明确导入旧浏览器调试设置，仅限尚未配置云端设置的账户。菜单与导入实现见 [CanvasFlagsMenu.ts](../../src/components/CanvasFlagsMenu.ts)。

## 修改与保存设置

菜单修改调用 `UserSettingsResource.update()`，立即预览并在去抖后通过 [PUT /api/user-settings](../../server/api/user-settings.put.ts) 提交 `{ revision, settings }`。请求须包含完整版本化设置，字段由 [validateUserSettings()](../../server/utils/userSettings.ts) 校验；未知字段或不完整配置会被拒绝。

后端通过 [saveUserSettings()](../../server/db/user-settings.ts) 按预期版本写入数据库，成功返回新版本。保存失败显示错误并保留当前预览，可重试。设置保存在数据库，不走画布和素材库的快照链路。

退出和站内离开前等待设置保存。账户切换或组件卸载时销毁旧资源、取消定时器与在途请求；相关生命周期在 [useAccountSession.ts](../../src/composables/useAccountSession.ts)。

## 处理设置冲突

版本不符时，PUT 返回 `409 USER_SETTINGS_CONFLICT`。设置资源再通过 [GET /api/user-settings](../../server/api/user-settings.get.ts) 读取云端版本，保留当前预览，并让用户选择：

- “采用云端”：`useCloud()` 用读到的云端配置替换当前预览。
- “重新提交当前值”：`keepLocal()` 保留当前配置，以读到的新版本再次 PUT；若又有其他页面写入，仍可能再次冲突。

这套选择与[画布草稿冲突](canvases.md#处理保存冲突)不同，分别由独立保存资源处理。

## 验证入口

[user-settings.test.ts](../../tests/backend/user-settings.test.ts) 检查字段、归属和版本，[user-settings-resource.test.ts](../../tests/backend/user-settings-resource.test.ts) 检查读取失败、预览、冲突选择及旧账户请求取消。浏览器中检查菜单即时预览、重登录恢复、双标签页冲突，以及读取失败时控件只读。
