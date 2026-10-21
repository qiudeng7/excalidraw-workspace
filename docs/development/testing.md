# 开发验证

[返回目录](../../README.md#目录)

在仓库根目录按变更范围运行。测试使用 Node.js 24+ 和仓库锁定的 pnpm 版本；先执行 `pnpm install --frozen-lockfile`。

| 范围                | 命令                                                                       | 验证内容                                                                     |
| ------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 宿主类型            | `pnpm typecheck`                                                           | 依次生成编辑器声明、准备 Nuxt 并检查 Vue、宿主和服务端类型                   |
| 隔离测试            | `pnpm test:unit`                                                           | 前端控制器、缓存、异步保存与快照失败处理；接口和存储使用替身                 |
| 进程内集成          | `pnpm test:integration`                                                    | SQLite、迁移、blob 驱动与真实 H3 处理器，包括认证并发时序、鉴权后的条件读取  |
| 前端 UI             | `pnpm test:browser`                                                        | Chromium 中的真实界面和编辑器，常规用例模拟 API；真实协作用例使用专用 runner |
| 本地 Workers / D1   | `pnpm test:worker`                                                         | 临时 Worker 上的设置、改密、兼容、缓存及目录分页 HTTP 回归                   |
| 真实协作浏览器      | `pnpm test:collaboration node`、`pnpm test:collaboration worker`           | 隔离真实服务，无 API mocks，并发编辑、三种查看模式、离线与撤销               |
| 代码风格与工具      | `pnpm lint`、`pnpm format:check`、`pnpm test:lint`、`pnpm check:staged`    | 静态检查、规则自身回归及临时 Git 仓库中的暂存区检查回归                      |
| 独立 HTTP 验收      | 本文后面的 `node tests/http/…` 命令                                        | API 重启持久化、目录与导航，分别使用全新测试库                               |
| Workers / Node 构建 | 串行执行 `pnpm build`、`pnpm build:node`                                   | 两种部署产物                                                                 |
| 编辑器包            | [构建与 Chromium 检查](../../packages/excalidraw/README.md#验证与更新上游) | 包自身构建和专用浏览器验证                                                   |

手动执行 `pnpm check`，依次运行 `lint`、`format:check`、`test:lint`、`test:unit`、`test:integration` 和 `typecheck`。提交和推送不会自动触发项目检查。快速定位问题可先运行相关 unit；integration 不启动应用 HTTP 服务，但迁移回归会执行独立 Nuxt CLI。

Nuxt 准备、类型检查和生产构建共用 `.nuxt` / `.output`，编辑器构建共用包内 `dist`，请在同一 checkout 串行执行。默认浏览器启动器独占临时 Nuxt 生成目录和 Vite 缓存，但仍先构建编辑器，不能与编辑器构建并行。各功能模块末尾还列有相关检查项。

## 代码检查

在仓库根目录手动运行：

```sh
pnpm check:staged    # 只检查 Git 暂存区中的新增、修改和重命名文件
pnpm lint            # ESLint：代码规则与异常处理
pnpm lint --fix      # 手动修复 ESLint 可修复的问题
pnpm format:check    # Prettier：检查排版
pnpm format          # 手动格式化，执行前先确认工作区改动
```

`pnpm check:staged` 对独立的暂存区快照运行 ESLint、Prettier 和 Git 空白检查，不修改工作区或暂存区。它适合部分暂存后的提交检查；修改 ESLint 配置时会检查完整代码范围。Prettier 范围见 [.prettierignore](../../.prettierignore)。项目不安装 Git hooks；检查脚本放在 `scripts/`，其回归用例与 ESLint 规则测试放在 `tests/lint/`。

## 测试目录和辅助代码

应用测试按执行边界放置，沿用 Node test、tsx 和 Playwright：

```text
tests/
├── unit/
│   ├── canvas-cache.test.ts
│   ├── frontend-controllers.test.ts
│   ├── persistence-owner.test.ts
│   ├── user-settings-resource.test.ts
│   └── snapshots.test.ts
├── integration/
│   ├── account-password.test.ts
│   ├── cleanup.test.ts
│   ├── conditional-snapshots.test.ts
│   ├── database-migrations.test.ts
│   ├── native-storage.test.ts
│   ├── navigation.test.ts
│   ├── node-storage.test.ts
│   ├── request-context.test.ts
│   ├── user-settings.test.ts
│   ├── user-settings-compat.test.ts
│   └── support/
│       ├── api.ts
│       ├── storage.ts
│       └── nitro.ts
├── browser/
│   ├── playwright.config.ts
│   ├── server.mjs
│   ├── fixtures.ts
│   └── *.spec.ts
├── http/
│   ├── run-worker.mjs
│   ├── api.mjs
│   ├── navigation.mjs
│   ├── user-settings.mjs
│   ├── account-compatibility.mjs
│   ├── cache.mjs
│   └── support/local-client.mjs
├── lint/
│   ├── error-handling.test.ts
│   ├── staged.test.mjs
│   └── fixture.mjs
└── lib/
    ├── loader.mjs
    ├── database.ts
    └── blobs.ts
```

控制器和保存资源在 Node 中使用替代接口，`canvas-cache.test.ts` 使用 fake-indexeddb 与替代网络验证缓存和异步保存，`snapshots.test.ts` 使用 mock 数据库和 blob，归 `unit`。组合真实 SQLite、迁移、文件 blob、SDK 驱动或 H3 处理器的用例归 `integration`，其中 `conditional-snapshots.test.ts` 使用真实处理器、SQLite 和文件 blob 检查鉴权后 304 及对象读取次数，R2 绑定仍由替身提供。`user-settings-compat` 包含客户端保存资源与真实后端的组合验证，也属于 integration。

`tests/lib/database.ts` 和 `blobs.ts` 是 AsyncLocalStorage 依赖注入上下文，不创建数据库或模拟固定查询结果；调用方可以注入真实存储或替身。`loader.mjs` 在这两组 Node 测试中把 `@nuxthub/db`、`@nuxthub/blob` 重定向到注入上下文，不参与浏览器、HTTP 或产品运行。

`integration/support/storage.ts` 创建真实的临时 SQLite、应用迁移并提供文件 blob；`api.ts` 发现真实 `server/api/` 路由并通过 H3 在进程内处理 Request，不监听端口；`nitro.ts` 提供独立执行处理器所需的运行时配置接口。浏览器 mock、HTTP client 和 Git fixture 分别留在所属套件，只有跨套件实际复用的代码进入 `tests/lib/`。

Node 入口只发现对应目录中的 `*.test.ts`，`test:lint` 同时发现 `tests/lint/` 中的 `*.test.ts` 和 `*.test.mjs`；Playwright 配置只发现 `browser/**/*.spec.ts`，输出固定到仓库根的 `test-results/browser/`，启动命令的 cwd 固定为仓库根。HTTP `.mjs` 是有参数及状态前提的 CLI，runner 使用明确用例列表，不 glob 执行所有文件。`scripts/check-staged.mjs` 是被测试的开发工具，保留在 `scripts/`。

`packages/excalidraw/tests/` 保留在编辑器包内，维护其上游测试源码、快照和专用 Chromium 脚本。宿主测试入口不会自动运行完整上游套件；可执行的编辑器验证以包内说明为准。

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

默认命令先构建编辑器，在空闲的回环端口启动独立 Nuxt dev 服务，结束时由 Playwright 关闭。它将存储、Nuxt 生成文件/类型和 Vite 依赖缓存放在本次运行的临时目录中，不执行数据库迁移。服务在 Vue 页面/组件依赖图预热、依赖优化完成后才开放端口，结束后删除这份临时目录。每个用例使用新的浏览器 context、虚拟账户和空画布；所有 `/api` 请求都由 fixture 响应，未知 API 会被阻止并使测试失败，不会访问真实账户或数据库。测试不需要代理配置或已有登录状态。

已有**本地测试服务**时可以跳过自动启动：

```sh
BROWSER_BASE_URL=http://127.0.0.1:3000 CHROMIUM_PATH=/usr/bin/chromium pnpm test:browser
```

此时命令不会关闭该服务。可以把 Playwright 参数接在命令后，例如 `pnpm test:browser tests/browser/settings-sync.spec.ts` 单独运行同步恢复场景。

回归覆盖普通用户/管理员的分类名称、默认通用页、图标区分和键盘导航；工具、选中元素和 Alt+R 查看模式保持；模态内键盘/剪贴板隔离及中文输入；文字编辑自然失焦提交；各分类的失败、冲突、未加载提示和恢复。布局测试参数化 9 种桌面/移动尺寸与上下工具栏，检查更多工具菜单方向、边界及末项可达，其中包含 568×320、1024×375 的低高度视口。页面运行异常、Nuxt 捕获的初始化异常、脚本 HTTP 错误和残留错误 overlay 都会使测试失败。

缓存回归可单独运行 `pnpm test:browser tests/browser/canvas-cache.spec.ts`，覆盖未打开素材库零请求、初始化不误保存空库、缓存校验期间修改入口隔离、旧画布后台保存和快返、失败重试、查看模式与工具恢复、克隆标签页草稿隔离，以及未加载素材库的 API 修改保护。时序用例输出本机小场景的 click-to-preview / click-to-editable，服务端响应由确定性屏障控制，用于比较受控加载时序。

失败截图与 trace 保存在忽略的 `test-results/browser/`，成功用例不保存截图。用 `pnpm exec playwright show-trace <trace.zip路径>` 查看 trace。浏览器测试验证前端行为，API 为模拟响应，测试服务关闭协作目录投影和对象清理后台任务；真实会话 SQL 和 D1 的结果由下面两套测试验证。

## 开发启动器回归

```sh
CHROMIUM_PATH=/usr/bin/chromium node tests/http/run-development.mjs node
CHROMIUM_PATH=/usr/bin/chromium node tests/http/run-development.mjs worker
```

两条命令串行执行。runner 用临时数据目录和空闲端口调用与 `pnpm dev` 相同的启动器，验证前后端预设一致、管理员和普通用户正常登录、注册页不预填、重复启动保留画布及会话、配置改密后旧密码和会话失效。Worker 场景还检查普通运行时的 bootstrap 不返回开发凭证，开发准备接口不可访问。测试结束关闭自己启动的服务并删除临时数据，只操作本地临时存储，不改默认开发目录，也不迁移远端。构建会更新当前 checkout 的 `.nuxt` / `.output` 和编辑器产物，请与其他构建串行运行。

`tests/lint/development-config.test.mjs` 验证开发配置的文件读取、环境变量优先级和校验；`tests/integration/development-accounts.test.ts` 验证账号初始化、密码哈希、关闭注册时准备预设及已有账号冲突保护，随 `pnpm check` 执行。

## 认证并发回归

```sh
pnpm test:integration
```

[改密测试](../../tests/integration/account-password.test.ts)使用临时 SQLite 与确定性屏障，分别让 login/setup/register 的真实会话 INSERT 在改密前或改密后完成。前者检查迟到响应签发的 Cookie 已失效，后者检查旧凭证无法插入会话；两者都检查当前会话保留、旧密码拒绝与新密码可用。屏障带超时并在 `finally` 释放，不依赖固定等待。此套测试直接调用请求处理器，不启动 HTTP 服务或 Cloudflare runtime。

## 本地 Workers / D1 回归

```sh
pnpm test:worker
```

命令先构建 Workers 产物，再创建临时 Wrangler state 目录，只向该目录的**本地 D1**迁移；随后使用空闲回环端口启动 Worker。正常结束、测试失败或终止时关闭 Worker 并删除这份状态，不迁移仓库默认 `.wrangler` 数据，不操作远端资源。构建会更新当前 checkout 的 `.nuxt` / `.output`，请与其他构建串行运行。

测试通过真实 HTTP 新建随机账户，验证当前会话保留/其他会话撤销、旧新密码、缺少新 flag 的原版及中间版 v1 设置保留已有 false、首次保存默认值及版本比较更新（CAS）。`test:worker` 执行 `tests/http/user-settings.mjs`、`tests/http/account-compatibility.mjs`、`tests/http/cache.mjs` 与 `tests/http/catalog-pagination.mjs`，覆盖设置白名单、账户隔离和并发保存。缓存 HTTP 回归在独立随机账户内写入画布和素材库，检查真实 `304` 无响应体、版本不匹配全量读取、owner/未登录拒绝及旧 revision 保存冲突；不执行需要独立空库的 `api.mjs`、`navigation.mjs`。目录 HTTP 回归在随机账号中创建 35 张画布，检查首屏分页、跨 30/31 条边界的局部移动、旧游标冲突、置顶精简响应与旧完整接口兼容。

这验证本地 Cloudflare runtime 的 D1 查询与批处理，不覆盖云端绑定、线上发布或浏览器交互。

也可使用已启动的独立本地 Worker：

```sh
pnpm test:worker http://127.0.0.1:3000
```

传入地址时跳过构建、迁移与启停，仅接受回环 HTTP origin。测试会保留新建的随机账户与测试数据；库若尚未初始化管理员，会通过 setup 创建随机测试管理员，否则需已开放注册。脚本不会重置已有账户或修改注册开关；请使用专用测试库。

## 其他 HTTP 验收

使用独立测试 checkout 和隔离数据。下面以本地 Workers / D1 为例，在仓库根目录执行；先确认示例端口 `18790` 空闲，若改端口，同时修改 origin 和所有客户端命令。脚本只接受回环 HTTP 地址，会创建账户并写入数据。

先构建一次，再为 API 场景创建全新状态，在终端 A 启动服务：

```sh
pnpm build
test_state=$(mktemp -d /tmp/excalidraw-http-test-XXXXXX)
test_origin=http://127.0.0.1:18790
pnpm exec wrangler d1 migrations apply DB --config wrangler.jsonc --local --persist-to "$test_state"
pnpm exec wrangler dev --config wrangler.jsonc --local --ip 127.0.0.1 --port 18790 --inspector-port 0 \
  --persist-to "$test_state" --var PUBLIC_ORIGIN:"$test_origin"
```

这些命令只迁移独占的本地状态，不使用默认 `.wrangler` 或远端资源。等待服务就绪后，在终端 B 运行下面的客户端命令。也可按[部署说明](../deployment.md)使用独立 Node 测试实例，仍须保证全新库、origin 一致及 API 场景的真实重启。

[API 脚本](../../tests/http/api.mjs)要求全新、无管理员的测试库，检查账户、权限、图片快照、素材库并发保存及空间操作：

```sh
api_state=$(mktemp /tmp/excalidraw-api-state-XXXXXX)
node tests/http/api.mjs prepare http://127.0.0.1:18790 "$api_state"
```

prepare 成功后，在终端 A 用 Ctrl+C 停止 Worker，并重新执行**同一条** `wrangler dev` 命令，保留同一个 `test_state` 和 origin；不要重新创建状态或迁移到另一个目录。服务重新就绪后，在终端 B 检查会话、登录与持久化：

```sh
node tests/http/api.mjs verify http://127.0.0.1:18790 "$api_state"
```

`api_state` 是本次运行独占的 `/tmp` 文件，包含测试凭证，脚本以 `0600` 权限写入；prepare 和 verify 在同一终端 B 复用该变量。verify 完成后先停止终端 A 的 Worker，再分别清理状态和凭证：

```sh
# 终端 A，仅删除本次 mktemp 创建且已经停服的状态目录。
rm -rf -- "$test_state"
# 终端 B。
rm -- "$api_state"
```

目录与导航场景要求**另一份全新库**。在终端 A 重新执行上述 `mktemp`、设置 origin、迁移和启动命令，不复用 API 场景的状态；在终端 B 执行：

```sh
node tests/http/navigation.mjs http://127.0.0.1:18790
```

另外两个脚本检查设置校验、账户隔离，以及改密和旧版设置兼容。可以继续使用目录场景的测试服务，或使用全新库／已开放注册的独立本地测试库；它们会创建随机测试账户，不调整已有库的注册开关：

```sh
node tests/http/user-settings.mjs http://127.0.0.1:18790
node tests/http/account-compatibility.mjs http://127.0.0.1:18790
```

完成后停止 Worker，再删除这次的 `test_state`。手动使用已有服务时不自动停服或删除数据。页面变更还需浏览器验收，HTTP 脚本不覆盖编辑器交互。

## 真实协作验收

```sh
CHROMIUM_PATH=/usr/bin/chromium pnpm test:collaboration node
CHROMIUM_PATH=/usr/bin/chromium pnpm test:collaboration worker
```

两条命令串行执行。runner 构建对应目标，为 Node 创建临时数据库并应用当前 SQL，或向临时 Wrangler state 应用本地 D1 迁移，再在空闲回环端口启动独占服务。runner 先运行备份 CLI 的图片、固定版本、新 epoch 恢复及校验和拒绝测试，再由 Playwright 使用真实账号、HTTP 和 WebSocket 验证协作，结束、失败和终止均清理本次服务及状态。不会迁移默认开发数据或线上数据库。已有专用测试服务可用 `BROWSER_BASE_URL=http://127.0.0.1:端口 COLLABORATION_LIVE_TEST=1 pnpm test:browser collaboration.spec.ts` 跳过 runner；测试会留下随机账号和画布。

可在 runner 命令后附加 Playwright 参数，例如 `pnpm test:collaboration node --grep 主画布` 定位单个浏览器用例。

协作用例覆盖主画布分享面板、账号邀请与共享入口、同账号与匿名编辑会话、远端变更不回传、撤销隔离、离线重连、撤销链接，以及最新版 / 固定版不连接 WebSocket、不请求访客的私有资源。纯核心、客户端队列及后端集成另见 `tests/unit/collaboration*.test.ts` 和 `tests/integration/collaboration.test.ts`。
