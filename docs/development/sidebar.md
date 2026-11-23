# 侧栏与文件组织

[返回目录](../../README.md#目录)

工作空间侧栏负责目录、收藏、排序和文件操作。顶部是品牌与空间切换，底部固定账号、回收站和设置，中部“与我共享”和“画布”共用一个滚动容器；折叠状态按账号与工作空间保存在当前浏览器，折叠只隐藏列表，不关闭画布、标签或后台保存。

## 文件夹

侧栏支持最多 5 层文件夹，文件夹与画布混排并共用一套顺序。点击文件夹展开或收起，单击画布打开；长列表按页加载，见下文分页。

新建、重命名、移动和删除都由行菜单发起。删除文件夹前会确认其中包含的文件数量，整组移入回收站，30 天内可恢复；整组恢复不会复活此前单独删除的文件，原位置不可用时可另选恢复位置。

目录数据在 [useWorkspaceDirectory.ts](../../src/composables/useWorkspaceDirectory.ts) 与 [use-directory-tree.ts](../../src/composables/use-directory-tree.ts)，后端实现见 [db/directory.ts](../../server/db/directory.ts) 和 [db/directory-batch.ts](../../server/db/directory-batch.ts)；批量移动、删除与深度校验在同一个事务内完成。

## 收藏

收藏替代早期的“置顶”：已置顶的画布会转为收藏，不再有独立的置顶分组。收藏是当前账号的独立列表，可以单独排序，不改变文件在目录中的原位置；点击收藏中的文件夹会定位到原目录。收藏只对所有者自己的空间生效，“与我共享”不参与。

写入通过 [PUT /api/workspaces/:id/favorites](../../server/api/workspaces/[id]/favorites.put.ts) 提交 `{ source, favorite, catalogRevision }`，排序通过 [favorites/order.put.ts](../../server/api/workspaces/[id]/favorites/order.put.ts) 提交完整收藏顺序。收藏状态与顺序由 `directory_favorites` 表保存，目录读取时以 `favorite` 字段返回。

## 拖动与排序

拖动整行可以调整顺序，拖到文件夹上即可移入；悬停会展开目标文件夹，按 Esc 取消。手机可长按拖动，轻触和正常滚动保持不变。排序按目录版本 `catalogRevision` 提交，失败后回读确认服务端结果，不自动重试旧操作。

移动和批量操作完成后，侧栏底部提供本次页面内的快捷撤销（撤销移动 / 撤销删除）；后续目录变化会使撤销失效，已删除内容仍可到回收站恢复。排序细节见[调整画布顺序](canvases.md#调整画布顺序)。

## 操作菜单

文件行不再显示三个点：右键打开目标文件的菜单，也可以用 `Shift+F10` 或菜单键打开；触屏长按 500ms 打开。菜单提供收藏/取消收藏、重命名、移动到、移入回收站等操作，画布与文件夹的菜单项略有差异。菜单支持方向键、Home/End 和 Enter/Space，Esc 关闭并把焦点还给触发行。

入口为 [DirectoryContextMenu.vue](../../src/components/DirectoryContextMenu.vue) 与 [SidebarResourceTree.vue](../../src/components/SidebarResourceTree.vue)。

## 分页与加载

画布列表每页 30 张，距滚动区底部约 160px 时自动追加；同一空间只保留一个追加请求，内容不足一屏时继续补页。失败保留已有页并提供“加载失败，重试”，最后一页显示“已显示全部 N 张画布”，标题计数来自服务端 `total`。

跨页调整顺序时保留其他画布的相对位置；其他页面修改列表后重新获取已加载范围。不在当前页中的标签、草稿和后台保存继续存在，最近画布、标签和深链接按 ID 直接加载。实现见 [use-sidebar-pagination.ts](../../src/composables/use-sidebar-pagination.ts)。

## 搜索与版本入口

在侧栏“工作空间”上方输入或按 `Ctrl/Cmd+P` 打开搜索，范围与匹配规则见[搜索画布内容](workspaces.md#搜索画布内容)。侧栏“画布空间”标题旁显示根 `package.json` 的真实版本，并提供 GitHub 仓库入口。

## 验证入口

- [sidebar-pagination.spec.ts](../../tests/browser/sidebar-pagination.spec.ts)：固定布局、分页、账号菜单与深浅主题。
- [catalog-pagination.test.ts](../../tests/integration/catalog-pagination.test.ts)、[workspace-pagination.test.ts](../../tests/unit/workspace-pagination.test.ts)：分页、游标冲突与页外资源。
- [directory-batch.test.ts](../../tests/integration/directory-batch.test.ts)、[directory-selection-geometry.test.ts](../../tests/unit/directory-selection-geometry.test.ts)：批量移动、删除与框选。
- [sidebar-multiselect.spec.ts](../../tests/browser/sidebar-multiselect.spec.ts)：框选与批量整理。
