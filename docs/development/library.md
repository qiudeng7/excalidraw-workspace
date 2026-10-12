# 个人素材库

[返回开发者指南](readme.md)

素材库属于账户，在该账户的所有画布间共享，有独立于画布的内容版本和快照。编辑器接入与冲突操作在 [ExcalidrawCanvas.client.vue](../../src/components/ExcalidrawCanvas.client.vue)。

## 读取素材库

[切换画布](canvases.md#切换画布)时，`useCanvasDocument.loadCanvas()` 并行读取目标画布与 [GET /api/library](../../server/api/library.get.ts)，两者均成功后才替换编辑器内容。HTTP 适配器 [workspaceApi.ts](../../src/lib/workspaceApi.ts) 发送 `X-Resource-Owner`，防止页面捕获的账户与当前登录 Cookie 不一致。

后端按登录用户读取 [db/snapshots.ts](../../server/db/snapshots.ts) 中的素材库引用，再读取快照；尚未保存内容时返回空数组。引用对象刚被并发保存替换时，重新读取数据库引用后再尝试一次。

## 保存素材库

编辑器的 `onLibraryChange` 将新条目交给 [PersistentResource](../../src/lib/persistence.ts)。该资源通过 [PUT /api/library](../../server/api/library.put.ts) 提交 `{ revision, items }`，并携带捕获的账户 ID；后端校验 `items` 为数组，再走与画布共用的 [saveSnapshot()](../../server/utils/snapshots.ts)。成功返回新版本与更新时间。

素材库与画布分别保存，没有跨两份内容的事务。切换或离开时，编辑器保存屏障等待两者完成；任一失败都会阻止依赖此屏障的操作。发生版本冲突时停止覆盖，可下载本地备份或确认舍弃冲突草稿后重新加载，交互见[处理保存冲突](canvases.md#处理保存冲突)。

素材库导入由编辑器处理，导入后的内容通过同一保存资源同步；文件格式与编辑器导入代码见[导入导出与复制](editor.md#导入导出与复制)。

## 验证入口

[node-storage.test.ts](../../tests/backend/node-storage.test.ts) 检查素材库读写、账户隔离与重启持久化，[snapshots.test.ts](../../tests/backend/snapshots.test.ts) 检查版本写入失败及新对象回收，[persistence-owner.test.ts](../../tests/backend/persistence-owner.test.ts) 检查旧账户保存取消。浏览器中检查添加素材后切换画布、刷新恢复、双标签页冲突，以及素材库保存失败是否阻止退出。
