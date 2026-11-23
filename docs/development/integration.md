# 被宿主集成

[返回目录](../../README.md#目录)

应用除了独立部署，还可以作为 Module Federation remote，被宿主应用（如 workbench）在运行时加载。Node 和 Cloudflare 两种部署都支持，不是第三种部署方式；是否发布 remote 由构建开关决定，账号方式由[账号方式开关](accounts.md#账号方式开关)决定。默认构建不产出任何 federation 文件，行为与独立部署相同。

## 选择暴露层次

remote 同时提供三层接口，宿主按需要自定义的程度选择：

| 暴露名                                                                                    | 层次     | 实现                                                                      | 适用                                 |
| ----------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `./WorkspaceApp`                                                                          | 整体应用 | [WorkspaceApp.vue](../../src/components/exposed/WorkspaceApp.vue)         | 直接嵌入完整的侧栏、画布与面板       |
| `./WorkspaceSidebar`、`./CanvasStage`、`./CanvasTabs`、`./SettingsPanel`、`./AccountGate` | 界面块   | [exposed/](../../src/components/exposed/)                                 | 宿主自行排布局，只借用某一块界面     |
| `./client`                                                                                | 无界面   | [createWorkspaceClient.ts](../../src/lib/client/createWorkspaceClient.ts) | 完全自定义界面，只调用数据与会话能力 |

整站页面 [index.vue](../../src/pages/index.vue) 只是 `WorkspaceApp` 的薄壳，独立部署与被集成运行同一份组装代码。`WorkspaceApp` 的主要 props 为 `mode`（`full` / `embed`）、`theme`（`light` / `dark` / `inherit`）、`apiBase`、`realtimeBase`、`initialCanvasId`；事件 `title-change`、`unsaved-change`；通过 ref 调用 `openCanvas(id)` 与 `flush()`。宿主路由离开前须等待 `flush()`，否则可能丢失未保存内容。

`client` 是唯一承诺稳定的层，界面块建立在它和同一组控制器之上：

```ts
const client = createWorkspaceClient({ apiBase: "/apps/excalidraw" });
await client.ready; // 读取会话与工作空间
client.session.value; // { status, canEdit, actAs, user }
const canvas = await client.openCanvas(id);
canvas.change(scene); // 自动保存
await canvas.flush();
canvas.close();
client.dispose();
```

`src/lib/client/` 与 [runtime.ts](../../src/lib/runtime.ts) 只依赖 `vue` 响应式和 `~/lib`，不得引入 Nuxt 运行时（`#app`、`useRoute`、`useRuntimeConfig`、`useCookie` 等），否则在宿主中无法运行。

## 构建 remote

```bash
MF_ENABLED=true pnpm build:node    # 或 MF_ENABLED=true pnpm build
```

产物在 `.output/public/` 下新增 `mf-manifest.json` 与 `remoteEntry.js`，随现有部署一起发布。`MF_NAME` 指定 federation 名称，默认 `excalidraw-workspace`，同一宿主内每个 remote 必须唯一。remote 只提供浏览器端模块（`ssr: false`），宿主不在服务端渲染这些组件。

共享依赖采用模块默认值：`vue`、`vue-router` 单例并复用宿主实例；React 与 Excalidraw 编辑器打包在 remote 内部。配置位于 [nuxt.config.ts](../../nuxt.config.ts)，仅在 `MF_ENABLED=true` 时注册模块。

## 宿主接入

宿主以 manifest 地址注册 remote：

```ts
moduleFederation: {
  config: {
    name: "workbench",
    remotes: {
      excalidraw: {
        type: "module",
        name: "excalidraw-workspace",
        entry: "https://workbench.example.com/apps/excalidraw/mf-manifest.json",
      },
    },
  },
},
```

会话沿用应用自己的 HttpOnly Cookie（`SameSite=Strict`），请求使用 `credentials: "same-origin"`。因此 remote 的页面资源、API 与 WebSocket 必须经宿主同源反向代理访问，不能直接跨域调用。

## 反向代理前缀

推荐宿主网关把 `/apps/excalidraw/*` 转发到应用，并**去掉前缀**再转发；应用的服务端路由保持不变。浏览器侧的地址由前缀派生：

| 配置                                        | 作用                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 构建期 `WORKSPACE_BASE`                     | federation `publicPath` 与编辑器资源路径 `EXCALIDRAW_ASSET_PATH`，如 `/apps/excalidraw`           |
| `apiBase` / `realtimeBase`                  | 组件 prop 或 `createWorkspaceClient()` 参数，决定 API 与 WebSocket 地址；默认空字符串即同源根路径 |
| `PUBLIC_ORIGIN`                             | 宿主对外 origin，用于来源校验与 Secure Cookie                                                     |
| `OIDC_REDIRECT_URI`、`OIDC_POST_LOGIN_PATH` | 带前缀的回调地址与登录后返回的宿主页面，见[OIDC 登录](accounts.md#oidc-登录)                      |

网关须保留 Cookie、Origin 与 `X-Requested-With` 请求头，不缓存 `/api/*`，并支持 `/api/canvases/{id}/realtime` 的 WebSocket Upgrade。

## 主题

`mode="embed"` 时，`WorkspaceApp` 在自身根节点设置 `data-theme`，设计 token 在该子树内生效（[workspace-tokens.css](../../src/assets/workspace-tokens.css)）。`theme="inherit"` 跟随宿主 `<html data-theme>` 与系统深色模式；整站模式仍由 [theme.client.ts](../../src/plugins/theme.client.ts) 控制根元素。

## 接口描述

其他服务调用 HTTP API 时，可从任一部署实例读取构建期生成的 `/_openapi.json` 生成 SDK，见[部署说明](../deployment.md#openapi-文档)。
