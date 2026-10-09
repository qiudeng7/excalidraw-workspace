# 前端模块边界

`src/pages/index.vue` 负责组装依赖、绑定页面和路由离开保护。HTTP 路径、账户生命周期、画布目录、最近位置和拖拽交互分别放在独立模块中。页面继续使用现有 DOM 和样式。

## 接口与状态归属

| 模块 | 公开接口 | 负责的状态和动作 |
| --- | --- | --- |
| `src/lib/accountApi.ts` | `AccountApi` | 启动状态、登录、注册、退出、管理注册权限的 HTTP 适配 |
| `src/lib/workspaceApi.ts` | `WorkspaceApi` | 工作空间、目录、画布、素材库、最近位置的 HTTP 适配 |
| `src/composables/useAccountSession.ts` | `AccountSessionController` | 当前账户、初始化、账户设置资源的创建与销毁、退出前保存 |
| `src/composables/useOperation.ts` | `OperationController` | 页面操作串行化、处理中状态、错误反馈 |
| `src/composables/useCanvasDocument.ts` | `CanvasDocumentController` | 画布与素材库一起读取成功后替换当前编辑器数据 |
| `src/composables/useWorkspaceNavigation.ts` | `NavigationController` | 最近位置和版本冲突提示，不控制编辑器选择 |
| `src/composables/useWorkspaceDirectory.ts` | `WorkspaceDirectoryController` | 目录版本、工作空间和画布增删改、切换、排序后重新确认列表 |
| `src/composables/useWorkspacePicker.ts` | `WorkspacePickerController` | 下拉菜单、焦点和键盘操作，通过注入的 `select` 请求选择 |
| `src/composables/useCanvasReorder.ts` | `CanvasReorderController` | 指针捕获、拖动、键盘移动，通过注入的 `reorder` 提交完整顺序 |
| `src/lib/editor.ts` | `EditorHandle` / `SaveBarrier` | 页面与编辑器之间的保存边界 |
| `src/lib/persistence.ts` | `SaveResource<T>` / `PersistentResourceOptions<T>` | 画布和素材库草稿、自动保存、冲突备份；通过具名选项捕获账户 |
| `src/lib/userSettings.ts` | `UserSettingsResource` / `UserSettingsStatus` | 用户设置的独立保存与冲突选择状态机 |

控制器通过公开动作修改自己的状态，对外暴露只读 ref。模板元素 ref 是例外：Vue 需要写入元素实例。目录依赖通过 `Pick` 只接收需要的能力；测试可以提供这些接口的替代实现，不需要挂载 Excalidraw。

页面的操作锁组合“正在操作”和“正在拖动”；目录自己叠加“服务端列表尚未确认”的锁。拖动控制器在目录创建之后绑定，组合层通过响应式槽读取拖动状态，避免初始化时读取尚未创建的控制器。账户回调与 owner getter 在挂载或用户操作时执行，此时依赖已绑定。

## 新增动作时

1. 涉及新 HTTP 调用时，先在 `AccountApi` 或 `WorkspaceApi` 声明具名方法，在适配器中处理 URL、请求体和响应 DTO。通用 `api` 拒绝成功状态下的无效 JSON，不能把 HTML 或 `null` 当成业务数据。
2. 将动作放到拥有对应状态的控制器中；通过接口传入保存屏障、对话框或通知能力，不直接改另一个控制器的 ref。页面只调用动作并绑定反馈。
3. 切换画布、退出或离开路由时保留保存屏障。目录 CAS 冲突后读取服务端列表，不自动重试旧顺序；最近位置冲突只提示并读取版本，不改变当前画布。
4. 新增窗口监听时在同一个控制器注销。拖拽取消和组件卸载都必须释放指针捕获；切换账户时必须先销毁旧账户的设置资源。

画布/素材库与用户设置有不同的恢复与冲突交互，保留两套保存状态机。账户身份仍随资源请求发送，由后端校验，不能因为拆模块去掉这层保护。

## 验证

`pnpm test:backend` 包含前端控制器和保存资源测试：成功非 JSON 响应、文档读取原子性、最近位置冲突、保存失败阻止切换、目录失败锁定，以及旧账户请求取消。`pnpm typecheck` 检查页面、Vue/React 包装层与接口类型。浏览器验收继续检查登录、工作空间下拉、画布排序和切换、flag 设置冲突、退出保护及 Ctrl / ⌘ S。
