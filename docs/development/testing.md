# 开发验证

[返回开发者指南](readme.md)

在仓库根目录按变更范围运行。测试使用 Node.js 24+ 和仓库锁定的 pnpm 版本；先执行 `pnpm install --frozen-lockfile`。

| 范围                          | 命令                                                                       | 验证内容                                                   |
| ----------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 宿主类型                      | `pnpm typecheck`                                                           | Vue、宿主与服务端类型                                      |
| API、数据库、保存资源、控制器 | `pnpm test:backend`                                                        | 隔离 SQLite 与请求夹具，包括认证并发时序                   |
| 设置与编辑器界面              | `pnpm test:browser`                                                        | Chromium 中的模态隔离、缓存只读、异步保存和工具栏布局      |
| 本地 Workers / D1             | `pnpm test:worker`                                                         | 临时 Worker 上的真实 HTTP、D1 会话撤销、设置兼容与条件读取 |
| 代码风格与错误处理            | `pnpm lint`、`pnpm test:lint`                                              | 静态规则与规则自身回归                                     |
| Workers / Node 构建           | 串行执行 `pnpm build`、`pnpm build:node`                                   | 两种部署产物                                               |
| 编辑器                        | [构建与 Chromium 检查](../../packages/excalidraw/README.md#验证与更新上游) | 编辑器包更新检查                                           |

Nuxt 生成、类型检查与构建共用 `.nuxt` / `.output`，请在同一 checkout 串行执行。各功能模块末尾还列有相关检查项。

## 浏览器回归

首次安装 Playwright 自带 Chromium，再运行测试：

```sh
pnpm exec playwright install chromium
pnpm test:browser
```

Linux 缺少浏览器运行依赖时，可运行 `pnpm exec playwright install --with-deps chromium` 安装浏览器及系统依赖。也可以使用已安装的 Chromium：

```sh
CHROMIUM_PATH=/usr/bin/chromium pnpm test:browser
```

默认命令先构建编辑器，在空闲的回环端口启动独立 Nuxt dev 服务，结束时由 Playwright 关闭。它使用临时存储目录，不执行数据库迁移，结束后删除这份临时数据。每个用例使用新的浏览器 context、虚拟账户和空画布；所有 `/api` 请求都由 fixture 响应，未知 API 会被阻止并使测试失败，不会访问真实账户或数据库。测试不需要代理配置或已有登录状态。

已有**本地测试服务**时可以跳过自动启动：

```sh
BROWSER_BASE_URL=http://127.0.0.1:3000 CHROMIUM_PATH=/usr/bin/chromium pnpm test:browser
```

此时命令不会关闭该服务。可以把 Playwright 参数接在命令后，例如 `pnpm test:browser tests/browser/settings-sync.spec.ts` 单独运行同步恢复场景。

回归覆盖普通用户/管理员的分类名称、默认通用页、图标区分和键盘导航；工具、选中元素和 Alt+R 查看模式保持；模态内键盘/剪贴板隔离及中文输入；文字编辑自然失焦提交；各分类的失败、冲突、未加载提示和恢复。布局测试参数化 9 种桌面/移动尺寸与上下工具栏，检查更多工具菜单方向、边界及末项可达，其中包含 568×320、1024×375 的低高度视口。页面运行异常也会使测试失败。

缓存回归可单独运行 `pnpm test:browser tests/browser/canvas-cache.spec.ts`，覆盖未打开素材库零请求、初始化不误保存空库、缓存校验期间修改入口隔离、旧画布后台保存和快返、失败重试、查看模式与工具恢复、克隆标签页草稿隔离，以及未加载素材库的 API 修改保护。时序用例输出本机小场景的 click-to-preview / click-to-editable，服务端响应由确定性屏障控制；用于复现实验，不是网络或大画布性能承诺。

失败截图与 trace 保存在忽略的 `test-results/browser/`，成功用例不保存截图。用 `pnpm exec playwright show-trace <trace.zip路径>` 查看 trace。浏览器测试验证前端行为，API 为模拟响应；真实会话 SQL 和 D1 的结果由下面两套测试验证。

## 认证并发回归

```sh
pnpm test:backend
```

[改密测试](../../tests/backend/account-password.test.ts)使用临时 SQLite 与确定性屏障，分别让 login/setup/register 的真实会话 INSERT 在改密前或改密后完成。前者检查迟到响应签发的 Cookie 已失效，后者检查旧凭证无法插入会话；两者都检查当前会话保留、旧密码拒绝与新密码可用。屏障带超时并在 `finally` 释放，不依赖固定等待。此套测试直接调用请求处理器，不启动 HTTP 服务或 Cloudflare runtime。

## 本地 Workers / D1 回归

```sh
pnpm test:worker
```

命令先构建 Workers 产物，再创建临时 Wrangler state 目录，只向该目录的**本地 D1**迁移；随后使用空闲回环端口启动 Worker。正常结束、测试失败或终止时关闭 Worker 并删除这份状态，不迁移仓库默认 `.wrangler` 数据，不操作远端资源。构建会更新当前 checkout 的 `.nuxt` / `.output`，请与其他构建串行运行。

测试通过真实 HTTP 新建随机账户，验证当前会话保留/其他会话撤销、旧新密码、缺少新 flag 的原版及中间版 v1 设置保留已有 false、首次保存默认值及版本比较更新（CAS）。同时运行设置白名单、账户隔离、并发保存和 `tests/http/cache.mjs` 条件读取 smoke。缓存 smoke 在独立随机账户内写入画布和素材库，检查实际 `304` 无响应体、版本变化全量读取、owner/未登录拒绝及旧 revision 保存冲突。这验证本地 Cloudflare runtime 的 D1 查询与批处理，不覆盖云端绑定、线上发布或浏览器交互。

也可使用已启动的独立本地 Worker：

```sh
pnpm test:worker http://127.0.0.1:3000
```

传入地址时跳过构建、迁移与启停，仅接受回环 HTTP origin。测试会保留新建的随机账户与测试数据；库若尚未初始化管理员，会通过 setup 创建随机测试管理员，否则需已开放注册。脚本不会重置已有账户或修改注册开关；请使用专用测试库。

## 其他 HTTP 验收

使用独立测试 checkout 和隔离数据，按[部署说明](../deployment.md)启动产物。脚本只接受回环 HTTP 地址，会创建账户并写入数据；下例端口及 `PUBLIC_ORIGIN` 须与测试服务一致。

[smoke-api.mjs](../../scripts/smoke-api.mjs)要求全新、无管理员的测试库，检查账户、权限、图片快照、素材库并发保存及空间操作：

```sh
node scripts/smoke-api.mjs prepare http://localhost:3000 /tmp/workspace-smoke.json
```

重启同一服务并保留测试数据，再检查会话、登录与持久化：

```sh
node scripts/smoke-api.mjs verify http://localhost:3000 /tmp/workspace-smoke.json
```

`/tmp/workspace-smoke.json` 包含测试凭证，验收后删除。

另外两个脚本分别检查目录与导航并发、DELETE 请求体，以及设置校验、账户隔离和版本冲突：

```sh
node scripts/smoke-navigation.mjs http://localhost:3000
node scripts/smoke-user-settings.mjs http://localhost:3000
node scripts/smoke-account-compatibility.mjs http://localhost:3000
```

[目录脚本](../../scripts/smoke-navigation.mjs)需要另一份全新测试库；[设置脚本](../../scripts/smoke-user-settings.mjs)及[改密与兼容脚本](../../scripts/smoke-account-compatibility.mjs)可使用开放注册的本地测试库。页面变更还需浏览器验收，HTTP 脚本不覆盖编辑器交互。
