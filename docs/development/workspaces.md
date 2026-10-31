# 工作空间

[返回目录](../../README.md#目录)

工作空间属于当前账户，每个空间包含独立的画布目录。用例由 [useWorkspaceDirectory.ts](../../src/composables/useWorkspaceDirectory.ts) 编排，[workspaceApi.ts](../../src/lib/workspaceApi.ts) 封装 HTTP 调用。工作空间下拉菜单的焦点和键盘交互在 [useWorkspacePicker.ts](../../src/composables/useWorkspacePicker.ts)。

## 恢复工作目录

登录后或刷新页面时，`loadWorkspaces()` 并行读取 [GET /api/workspaces](../../server/api/workspaces/index.get.ts) 和 [GET /api/navigation](../../server/api/navigation.get.ts)。前者返回当前账户的工作空间，后者返回最近打开位置及导航版本。

前端优先检查最近工作空间的目录，通过 [GET /api/workspaces/:id/canvases](../../server/api/workspaces/[id]/canvases.get.ts) 取得画布及 `catalogRevision`。最近空间已删除或为空时，寻找第一个非空空间；全部为空时显示空空间，不自动创建画布。找到画布后执行[画布读取流程](canvases.md#切换画布)。

最近位置读取失败时，仍可使用工作空间与画布列表，并显示降级提示；目录读取失败则反馈错误。

## 切换工作空间

`selectWorkspace()` 先确认当前画布的本地草稿落盘，旧画布在后台同步，再读取目标空间目录。优先恢复该空间当前标签，其次使用账户记录的最近画布，无有效记录时选第一张；空空间显示新建入口。用户已关闭该空间全部标签时保持空白，不自动重开画布。

相关 API 为 [GET /api/navigation](../../server/api/navigation.get.ts)、[GET /api/workspaces/:id/canvases](../../server/api/workspaces/[id]/canvases.get.ts)，以及[切换画布](canvases.md#切换画布)中的读取和导航写入接口。画布读取独立于账户级素材库的按需加载，不等待素材库读取或云端保存。本地草稿保护或目标内容读取失败时保留原编辑器；快速切换时只应用最后一次选择。

## 创建工作空间

`createWorkspace()` 收集名称并等待编辑器保存，再调用 [POST /api/workspaces](../../server/api/workspaces/index.post.ts)。后端通过 [db/workspaces.ts](../../server/db/workspaces.ts) 插入当前账户的新空间。

成功后前端将空间加入列表，刷新导航并读取新空间目录。新建空间为空，不自动创建画布；注册时创建初始画布是[账户初始化](accounts.md#初始化管理员)中的独立行为。

## 重命名工作空间

`renameWorkspace()` 通过 [PATCH /api/workspaces/:id](../../server/api/workspaces/[id].patch.ts) 提交名称。后端验证归属和名称，更新数据库后返回空间信息；前端用返回值替换列表中的条目。

## 删除工作空间

`deleteWorkspace()` 先确认删除并等待编辑器保存，再调用 [DELETE /api/workspaces/:id](../../server/api/workspaces/[id].delete.ts)。后端验证归属，记录服务端回收时间，隐藏空间及关联画布并暂停协作访问，保留场景和图片供 30 天内恢复。

成功后前端清空当前文档，重新加载工作空间和最近位置。删除的范围包含空间下所有画布；恢复空间不会恢复此前单独回收的画布。底层实现见 [db/recycle-bin.ts](../../server/db/recycle-bin.ts) 和 [schema.ts](../../server/db/schema.ts)，恢复、确认彻底删除及到期清理见[回收站与彻底删除](canvases.md#回收站与彻底删除)。

## 框选与批量整理

「我的文件」保留单击打开画布、单击展开文件夹。Ctrl/Cmd 单击添加或取消选择，Shift 单击连续选择，Ctrl/Cmd + Shift 追加一段选择；这些修饰键点击不会打开画布。

从列表侧边或下方的空白处拖动可框选。按住 Ctrl/Cmd 框选会切换框内项目的选中状态，Shift 框选则保留原选项并追加。框选和范围选择只涉及当前展开、已加载的行，收藏与共享不参与；选中文件夹后，实际操作仍包含其中的活跃内容。

拖动已选行会移动整组，也可使用选中操作区或右键菜单的「移动到」「移入回收站」。批量删除先显示去重后的文件夹、画布总数并确认，再保存所有已打开画布的草稿；成功后只关闭实际被删除的画布。父文件夹和子项同时选中时，以父文件夹为准，不再单独处理选中的子项。一次最多提交 100 个选中行，此限制不限制所选文件夹包含的后代数量。

手机可从行菜单的「选择多个」进入勾选模式，使用独立的文件夹展开按钮浏览下级，完成后点「退出多选」。普通轻触、滚动和长按拖动不变。Esc 先取消当前手势或关闭菜单，再清空选择；勾选模式清空后再按一次 Esc 才退出。

批量移动和删除提供当前页面内的快捷撤销。移动撤销会回到各自原文件夹和原顺序，删除撤销不会重新打开画布标签。后续目录变化会使快捷撤销失效；已删除的内容仍可到回收站恢复，批量删除的文件夹和独立画布也可分别恢复。

开发接口集中在 [directory-contracts.ts](../../shared/directory-contracts.ts)：`directory/batch/summary` 读取去重统计，`move`、`delete`、`undo` 分别整批执行。每次批量目录变更在同一数据库事务中完成，并只递增目标空间的 `catalogRevision` 一次；已有单项接口保持不变。前端由 [use-directory-tree.ts](../../src/composables/use-directory-tree.ts) 编排，保存、关闭画布仍使用现有画布资源端口。

服务端确认写入后，界面刷新失败不会被当成写入失败，也不会重复提交。若响应丢失，界面会提示结果未确认，需要刷新核实：移动后检查目标文件夹内的项目和顺序，删除后检查回收站。目录仍无法读取时，先等待恢复，不重复提交同一批操作；没有成功回执时不生成快捷撤销记录。

## 验证入口

[frontend-controllers.test.ts](../../tests/unit/frontend-controllers.test.ts) 和 [navigation.test.ts](../../tests/integration/navigation.test.ts) 覆盖目录恢复、空空间、最近位置及控制器失败行为。浏览器中检查切换空间的保存保护、新建空空间、删除当前空间后的落点，以及下拉菜单键盘操作。
