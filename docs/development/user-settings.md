# 账户设置

[返回开发者指南](readme.md)

工作空间侧边栏底部的“设置”打开 [SettingsPanel.vue](../../src/components/SettingsPanel.vue)，左侧上方包含“通用”“编辑器”“账号”“调试”；管理员专属的“系统设置”位于左侧下方。绘图功能、采样倍率与渲染开关按账户保存，独立于画布场景和撤销历史；控件定义与旧配置读取在 [settingsControls.ts](../../src/lib/settingsControls.ts)。保存与冲突状态在 [userSettings.ts](../../src/lib/userSettings.ts)，完整类型与默认值在 [shared/contracts.ts](../../shared/contracts.ts)。

“通用”中的外观主题按浏览器保存；管理员在“系统设置”中可切换注册开放状态；“账号”提供[修改密码](accounts.md#修改密码)。通用、系统与账号设置不走绘图设置的版本与保存队列。

## 加载设置

[账户加载](accounts.md#恢复登录状态)时，`useAccountSession` 为当前账户创建设置资源，通过 [GET /api/user-settings](../../server/api/user-settings.get.ts) 读取。请求携带 `X-Settings-Owner`；后端比较该值与登录用户，防止旧页面请求操作新账户。

没有云端记录时，返回默认设置、`revision: 0`、`configured: false`。读取失败时按默认值展示，但设置控件保持只读；重试读取成功后才允许修改，避免用默认值覆盖未读到的云端配置。

用户可在“调试”分类明确导入旧浏览器调试设置，仅限尚未配置云端设置的账户。旧账户的 v1 配置若缺少 `disableDefaultSidebar` 或 `bottomToolbar`，读取时分别补为 `true`，保留其他选项和现有版本；后续保存完整设置。

“编辑器”中的“工具栏置底”默认开启，关闭后工具栏移至顶部，桌面与移动端均即时生效。该项通过画布容器样式切换布局，沿用提交 `f964f63` 的底部工具栏、提示与更多工具菜单定位调整；不改动画布元素。

## 修改与保存设置

面板中的编辑器与调试修改调用 `UserSettingsResource.update()`，立即预览并在去抖后通过 [PUT /api/user-settings](../../server/api/user-settings.put.ts) 提交 `{ revision, settings }`。字段由 [validateUserSettingsWrite()](../../server/utils/userSettings.ts) 校验，接受三种已发布的完整 `version: 1` 结构：最初不含 `disableDefaultSidebar` 和 `bottomToolbar` 的结构、含 `disableDefaultSidebar` 但不含 `bottomToolbar` 的结构，以及包含两者的当前结构。其他字段在三种结构中都必须完整且类型正确；未知字段、任意局部更新及仅含 `bottomToolbar` 而缺少 `disableDefaultSidebar` 的结构会被拒绝。

旧客户端缺少的新增选项，从同一账户当前云端设置中保留；云端没有记录时采用默认值，两项均为 `true`。旧存储记录本身缺少的选项也按读取规则补齐。客户端明确传入的 `false` 会保留。后端保存并返回补齐后的完整设置，部署前已打开的旧标签页可继续保存与重试。

后端通过 [saveUserSettings()](../../server/db/user-settings.ts) 按预期版本写入数据库，成功返回新版本。旧结构的读取补齐与保存之间若有其他请求写入，仍按版本冲突处理，避免覆盖较新的选项。保存失败显示错误并保留当前预览，可重试；读取失败、保存错误和冲突的恢复入口在设置面板各分类中都可见。设置保存在数据库，不走画布和素材库的快照链路。

退出和站内离开前等待设置保存。账户切换或组件卸载时销毁旧资源、取消定时器与在途请求；相关生命周期在 [useAccountSession.ts](../../src/composables/useAccountSession.ts)。

## 处理设置冲突

版本不符时，PUT 返回 `409 USER_SETTINGS_CONFLICT`。设置资源再通过 [GET /api/user-settings](../../server/api/user-settings.get.ts) 读取云端版本，保留当前预览，并让用户选择：

- “采用云端设置”：`useCloud()` 用读到的云端配置替换当前预览。
- “保存当前设置”：`keepLocal()` 保留当前配置，以读到的新版本再次 PUT；若又有其他页面写入，仍可能再次冲突。

这套选择与[画布草稿冲突](canvases.md#处理保存冲突)不同，分别由独立保存资源处理。

## 验证入口

[user-settings.test.ts](../../tests/backend/user-settings.test.ts) 检查字段、归属和版本，[user-settings-compat.test.ts](../../tests/backend/user-settings-compat.test.ts) 检查旧客户端写入、新增选项保留及补齐过程中的版本竞争，[user-settings-resource.test.ts](../../tests/backend/user-settings-resource.test.ts) 检查读取失败、预览、冲突选择及旧账户请求取消。浏览器中检查设置面板的分类切换、即时预览、重登录恢复、双标签页冲突，以及读取失败时控件只读。
