# 架构与开发约束

[返回目录](../../README.md#目录)

应用使用 Nuxt 4、Vue、TypeScript 和 Pinia，通过浏览器端 React 组件挂载 Excalidraw，依赖由 pnpm workspace 管理。数据库通过 NuxtHub 与 Drizzle 接入，快照通过 NuxtHub Blob 保存。Node 使用 SQLite 与私有文件目录，Workers 使用 D1 与私有 R2；协作房间分别由 DO SQLite 和本地 SQLite 保存权威状态，两端共用纯 TypeScript 合并与权限核心。功能流程从[模块与用例](../../README.md#目录)进入，本页说明跨功能的开发约束。

## 页面与状态边界

[src/pages/index.vue](../../src/pages/index.vue) 组装依赖、绑定模板和路由离开保护。根路径 `/` 是画布，`/home` 为首页，`/about` 为关于页；[nuxt.config.ts](../../nuxt.config.ts) 将旧地址 `/draw` 重定向到 `/`。控制器拥有自己的状态，对外暴露动作与只读 ref；需要其他控制器能力时通过接口传入，避免直接修改另一个控制器的状态。

| 职责                               | 实现                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 账户生命周期与设置资源创建、销毁   | [useAccountSession.ts](../../src/composables/useAccountSession.ts)                                                                     |
| 工作空间、画布目录和目录版本       | [useWorkspaceDirectory.ts](../../src/composables/useWorkspaceDirectory.ts)                                                             |
| 画布缓存预览与只读版本校验         | [useCanvasDocument.ts](../../src/composables/useCanvasDocument.ts)                                                                     |
| 最近位置、导航版本和提示           | [useWorkspaceNavigation.ts](../../src/composables/useWorkspaceNavigation.ts)                                                           |
| 操作串行化与错误反馈               | [useOperation.ts](../../src/composables/useOperation.ts)                                                                               |
| 选择菜单、焦点和排序手势           | [useWorkspacePicker.ts](../../src/composables/useWorkspacePicker.ts)、[useCanvasReorder.ts](../../src/composables/useCanvasReorder.ts) |
| 账号级资源、后台队列与素材库懒加载 | [canvasResources.ts](../../src/lib/canvasResources.ts)、[persistence.ts](../../src/lib/persistence.ts)                                 |
| 账户设置保存与冲突选择             | [userSettings.ts](../../src/lib/userSettings.ts)                                                                                       |

新增 HTTP 调用放到相应 API 适配器，目录与账户控制器分别依赖 [WorkspaceApi](../../src/lib/workspaceApi.ts) 和 [AccountApi](../../src/lib/accountApi.ts)。通用 [api.ts](../../src/lib/api.ts) 统一请求头和错误解析，成功状态下的无效 JSON 也按错误处理。

跨画布使用 [SaveBarrier](../../src/lib/editor.ts) 的本地草稿 checkpoint，云端写入由账号级资源继续执行；退出和离开页面等待所有未同步资源。账户设置另有保存屏障。新增窗口事件监听须同时处理注销，拖拽取消和卸载须释放指针捕获。

## 请求与权限边界

[server/api/](../../server/api/) 负责请求校验、业务编排和响应；[server/db/](../../server/db/) 按资源组织查询。[defineApiHandler()](../../server/utils/api.ts) 统一来源校验、默认登录校验和 JSON 错误。公开账户与分享接口显式使用 `{ public: true }`，仍执行来源校验。

非 GET/HEAD 请求要求 `Origin` 等于配置的公开 origin，且 `X-Requested-With: excalidraw-demo`。来源和反向代理配置见[部署说明](../deployment.md#docker)。[http.ts](../../server/utils/http.ts) 解析 JSON 请求体并限制在 20 MB；[apiRequest()](../../server/utils/request.ts) 保留 Workers 的 DELETE 请求体。

错误格式为 `{ error: { code, message } }`。未知 API 由 [兜底处理器](../../server/api/[...path].ts) 返回 JSON 错误；导航、账户设置、管理设置和排序路径另有无方法后缀的处理器，对不支持的方法返回 405，业务方法由同路径的 `.get.ts`、`.put.ts` 等文件实现。

身份仅缓存在当前请求，资源查询显式传入登录用户 ID 并约束归属。私有目录访问按账号归属校验；协作访问则使用房间所有者、成员或显式链接授权，见[协作权限](collaboration.md)。素材库和设置的 owner 请求头用于发现页面账户已变化，实际授权仍以会话和数据库归属为准。

## 版本与快照

版本字段用于比较并交换（CAS）：仅当服务端版本等于请求携带的版本时写入，成功后递增。各版本保护不同的数据，不能互相替代：

| 版本                       | 保护范围             | 冲突处理                           |
| -------------------------- | -------------------- | ---------------------------------- |
| 旧画布 / 素材库 `revision` | 各自的内容快照       | 停止覆盖，提供备份与加载云端操作   |
| 工作空间 `catalogRevision` | 画布创建、删除与排序 | 重新确认目录，不自动重试旧操作     |
| 导航 `revision`            | 最近打开位置         | 提示并读取最新版本，不切换当前画布 |
| 账户设置 `revision`        | 完整用户设置         | 读取云端，让用户选择采用或重新提交 |

账户及初始资源创建、目录修改和导航写入使用 `db.batch()` 原子执行数据库批次。条件写入同时约束资源归属与版本，通过返回结果判断是否成功。表结构与索引见 [schema.ts](../../server/db/schema.ts)。

画布和素材库的内容先写入不可变 JSON 快照，再更新数据库引用。[saveSnapshot()](../../server/utils/snapshots.ts) 等待 `blob.put()` 成功后，调用 [publishSnapshot()](../../server/db/snapshots.ts) 按预期版本发布新引用。数据库失败或版本冲突时后台删除新对象，发布成功后后台删除旧对象。数据库与 Blob 不在同一事务中，进程中断留下的对象由回收任务处理。

协作画布使用独立 `epoch + seq` 和操作去重，不使用整图 revision CAS；新客户端首次读取会迁移旧画布并阻止旧 PUT 发布。协议、固定版本、图片引用和恢复路径见[协作与分享](collaboration.md)。

## 孤立快照回收

[snapshots:cleanup](../../server/tasks/snapshots/cleanup.ts) 每小时执行，[collectOrphans()](../../server/utils/cleanup.ts) 仅删除超过 24 小时、没有数据库引用的 JSON 或旧临时对象，避免清理尚未发布的新写入。

引用检查和删除按最多 100 个对象分批执行，两张引用表的 `object_key` 有索引。R2 使用 cursor 遍历；当前本地 Blob 驱动一次枚举整个目录，本地枚举内存仍随文件数增长。该任务独立于用户 API，并跳过 `collaboration/` 命名空间；协作对象依据权威房间引用单独回收。

## 数据迁移

修改 [schema.ts](../../server/db/schema.ts) 后在仓库根目录执行 `pnpm db:generate`，检查并提交生成的 SQL、schema 快照和 journal。迁移位于 [server/db/migrations/sqlite/](../../server/db/migrations/sqlite/)，两端共用；已发布迁移保持不变，新变更增加迁移文件。

开发与 Node 启动先由脚本运行 NuxtHub 迁移，Docker 由迁移服务成功后启动应用；D1 使用 Wrangler 及既有 `d1_migrations` 记录。构建和开发插件不自动迁移。数据路径、部署与备份见[部署说明](../deployment.md)。
