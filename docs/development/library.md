# 个人素材库

[返回目录](../../README.md#目录)

素材库属于账户，在该账户的所有画布间共享，有独立于画布的内容版本和快照。编辑器接入与冲突操作在 [ExcalidrawCanvas.client.vue](../../src/components/ExcalidrawCanvas.client.vue)。

## 读取素材库

素材库由账号级 [CanvasResources](../../src/lib/canvasResources.ts) 管理，具有 `unloaded / loading / ready / error / conflict` 状态。未加载与已经加载的空数组分别表示，不用空列表占位去更新云端。

默认侧边栏关闭时不自动发送素材库读取；侧边栏启用但素材库未打开时也不发送。用户首次打开素材库才调用 `ensureLibrary()`：先读取已同步本地缓存并只读展示，再通过 [GET /api/library](../../server/api/library.get.ts) 校验云端版本。版本一致可返回 `304`，无需读取对象存储。成功后注入编辑器并允许素材操作，同账号切换画布复用资源。

[workspaceApi.ts](../../src/lib/workspaceApi.ts) 发送 `X-Resource-Owner`，防止页面捕获的账户与当前登录 Cookie 不一致。后端按登录用户读取素材库数据库引用与快照；尚未保存内容时返回真实空数组。对象刚被并发保存替换时，重新读取数据库引用后再尝试一次。

未加载或正在校验时，编辑器的中心素材更新入口拒绝修改，覆盖 API、导入、重置和上下文菜单等路径；初始化注入回调与指纹相同的回调不安排保存。加载失败只提示素材库错误，可单独重试，画布继续使用。

## 保存素材库

编辑器的 `onLibraryChange` 将新条目交给 [PersistentResource](../../src/lib/persistence.ts)。该资源通过 [PUT /api/library](../../server/api/library.put.ts) 提交 `{ revision, items }`，并携带捕获的账户 ID；后端校验 `items` 为数组，再走与画布共用的 [saveSnapshot()](../../server/utils/snapshots.ts)。成功返回新版本与更新时间。

单次素材库 JSON 保存上限为 20 MB，超出时提示错误并保留本地草稿。

素材库与画布分别保存，没有跨两份内容的事务。关闭侧边栏或切换画布不会取消已有的素材库保存；退出登录与站内离开等待所有未同步资源，任一失败都会阻止离开。发生版本冲突时停止覆盖，可下载本地备份或确认舍弃冲突草稿后重新加载，交互见[处理保存冲突](canvases.md#处理保存冲突)。

素材库导入由编辑器处理，导入后的内容通过同一保存资源同步；文件格式与编辑器导入代码见[导入导出与复制](editor.md#导入导出与复制)。

## 验证入口

[node-storage.test.ts](../../tests/integration/node-storage.test.ts) 检查素材库读写、账户隔离与重启持久化，[snapshots.test.ts](../../tests/unit/snapshots.test.ts) 检查版本写入失败及新对象回收，[persistence-owner.test.ts](../../tests/unit/persistence-owner.test.ts) 检查旧账户保存取消。[canvas-cache.test.ts](../../tests/unit/canvas-cache.test.ts) 与 [canvas-cache.spec.ts](../../tests/browser/canvas-cache.spec.ts) 检查零提前读取、请求合并、空库不误保存及跨画布复用。浏览器中另检查双标签页冲突，以及素材库保存失败是否阻止退出。
