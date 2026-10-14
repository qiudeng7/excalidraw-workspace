# 工作空间

[返回开发者指南](readme.md)

工作空间属于当前账户，每个空间包含独立的画布目录。用例由 [useWorkspaceDirectory.ts](../../src/composables/useWorkspaceDirectory.ts) 编排，[workspaceApi.ts](../../src/lib/workspaceApi.ts) 封装 HTTP 调用。工作空间下拉菜单的焦点和键盘交互在 [useWorkspacePicker.ts](../../src/composables/useWorkspacePicker.ts)。

## 恢复工作目录

登录后或刷新页面时，`loadWorkspaces()` 并行读取 [GET /api/workspaces](../../server/api/workspaces/index.get.ts) 和 [GET /api/navigation](../../server/api/navigation.get.ts)。前者返回当前账户的工作空间，后者返回最近打开位置及导航版本。

前端优先检查最近工作空间的目录，通过 [GET /api/workspaces/:id/canvases](../../server/api/workspaces/[id]/canvases.get.ts) 取得画布及 `catalogRevision`。最近空间已删除或为空时，寻找第一个非空空间；全部为空时显示空空间，不自动创建画布。找到画布后执行[画布读取流程](canvases.md#切换画布)。

最近位置读取失败时，仍可使用工作空间与画布列表，并显示降级提示；目录读取失败则反馈错误。

## 切换工作空间

`selectWorkspace()` 等待当前画布和素材库保存 → 刷新最近位置 → 读取目标空间目录 → 打开该空间最近使用的画布，无有效记录时选第一张。空空间显示新建入口。

相关 API 为 [GET /api/navigation](../../server/api/navigation.get.ts)、[GET /api/workspaces/:id/canvases](../../server/api/workspaces/[id]/canvases.get.ts)，以及[切换画布](canvases.md#切换画布)中的读取和导航写入接口。画布与素材库都读取成功后，才替换当前文档和目录；保存或目标内容读取失败时保留原编辑器。

## 创建工作空间

`createWorkspace()` 收集名称并等待编辑器保存，再调用 [POST /api/workspaces](../../server/api/workspaces/index.post.ts)。后端通过 [db/workspaces.ts](../../server/db/workspaces.ts) 插入当前账户的新空间。

成功后前端将空间加入列表，刷新导航并读取新空间目录。新建空间为空，不自动创建画布；注册时创建初始画布是[账户初始化](accounts.md#初始化管理员)中的独立行为。

## 重命名工作空间

`renameWorkspace()` 通过 [PATCH /api/workspaces/:id](../../server/api/workspaces/[id].patch.ts) 提交名称。后端验证归属和名称，更新数据库后返回空间信息；前端用返回值替换列表中的条目。

## 删除工作空间

`deleteWorkspace()` 先确认删除并等待编辑器保存，再调用 [DELETE /api/workspaces/:id](../../server/api/workspaces/[id].delete.ts)。后端验证归属，记录服务端回收时间，隐藏空间及关联画布并暂停协作访问，保留场景和图片供 30 天内恢复。

成功后前端清空当前文档，重新加载工作空间和最近位置。删除的范围包含空间下所有画布；恢复空间不会恢复此前单独回收的画布。底层实现见 [db/recycle-bin.ts](../../server/db/recycle-bin.ts) 和 [schema.ts](../../server/db/schema.ts)，恢复、确认彻底删除及到期清理见[回收站与彻底删除](canvases.md#回收站与彻底删除)。

## 验证入口

[frontend-controllers.test.ts](../../tests/unit/frontend-controllers.test.ts) 和 [navigation.test.ts](../../tests/integration/navigation.test.ts) 覆盖目录恢复、空空间、最近位置及控制器失败行为。浏览器中检查切换空间的保存保护、新建空空间、删除当前空间后的落点，以及下拉菜单键盘操作。
