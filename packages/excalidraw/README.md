# 本地 Excalidraw 源码

本目录把 Excalidraw 编辑器及其内部依赖纳入当前 Git 仓库维护。Excalidraw Workspace 通过 `workspace:*` 使用这里的源码构建产物，不再依赖 npm 上的编辑器包或 pnpm patch。

## 来源与目录

源码来自 [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw)，基线为 `master` 提交 [`438d89861f53d8a90ad566113ecac1b83761098f`](https://github.com/excalidraw/excalidraw/commit/438d89861f53d8a90ad566113ecac1b83761098f)（2026-09-27），不是 npm 稳定版。精确来源保存在 [UPSTREAM.json](UPSTREAM.json)，上游 MIT 许可证保存在 [LICENSE](LICENSE)；`fractional-indexing` 沿用上游标注的 CC0-1.0，各字体目录也保留了上游随附的许可文件。

| 目录 | 内容 |
| --- | --- |
| [当前目录](./) | React 编辑器、渲染器、菜单、字体和语言资源 |
| [lib/common/](lib/common/) | 公共常量、类型与基础函数 |
| [lib/element/](lib/element/) | 图形模型、几何计算和元素渲染 |
| [lib/fractional-indexing/](lib/fractional-indexing/) | 为元素层级生成可插入的排序键 |
| [lib/math/](lib/math/) | 几何计算与数学类型 |
| [lib/utils/](lib/utils/) | 碰撞、导出等工具函数 |

六个包统一由仓库根目录的 [pnpm-workspace.yaml](../../pnpm-workspace.yaml) 管理，`common`、`element`、`fractional-indexing`、`math` 和 `utils` 是独立 workspace 包，通过 `workspace:*` 引用。上游路径与本地路径的对应关系记录在 `UPSTREAM.json` 的 `localPaths` 中；上游包说明保留在 [README.upstream.md](README.upstream.md)。

这些目录是普通源码目录，没有嵌套 `.git` 或 submodule。上游的网站应用、示例、文档站和发布工作流未引入；编辑器包里的上游测试保留供后续维护参考，当前仓库尚未接入其完整测试运行环境。

## 构建和开发

在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 先构建本地编辑器，再启动 Nuxt 开发服务。账户与保存使用本地 SQLite 和文件目录；Workers 模拟方式见[根目录 README](../../README.md#本地启动)。其余命令：

```sh
pnpm build:editor # 只构建六个源码包所需的编辑器 JS、CSS、字体和类型声明
pnpm build        # 构建编辑器和 Nuxt Workers 产物
pnpm build:node   # 构建编辑器和 Nuxt Node 服务
```

编辑器的开发版和生产版由同一份 TypeScript 源码生成，分别输出到 `packages/excalidraw/dist/dev` 和 `packages/excalidraw/dist/prod`。内部依赖包的实现打包进编辑器，类型声明同步到对应包的 `dist/`，防止 Vue 宿主以自己的 JSX 规则检查 React 源码。生成的 `dist/` 均不提交。

修改编辑器后重新运行 `pnpm build:editor`。连续调整渲染代码时，可在另一个终端运行：

```sh
pnpm --filter @excalidraw/excalidraw build:watch
```

这个命令监听并重建 JavaScript/CSS，不重新生成类型声明；涉及公共类型的修改仍需运行完整的 `pnpm build:editor`。若浏览器仍使用旧依赖缓存，重启 Nuxt 开发服务。

## 本仓库的定制

| 定制 | 源码位置 | 行为 |
| --- | --- | --- |
| 普通开口箭头头部 | [lib/element/src/bounds.ts](lib/element/src/bounds.ts) 的 `getArrowheadSize`、`getArrowheadAngle` | 由实例 `shortArrowheads` 控制：开启时最大侧翼长度 14、单侧角度 28°，关闭恢复 25、20°；其他头部类型和短箭头限制保留 |
| 复制 PNG 快捷键 | [actions/actionClipboard.tsx](actions/actionClipboard.tsx) 的 `actionCopyAsPng` | Windows/Linux 用 `Ctrl+Shift+C`，macOS 用 `Cmd+Shift+C`，排除 Alt |
| 命令面板 | [components/LayerUI.tsx](components/LayerUI.tsx) | 挂载上游 CommandPalette 组件，为独立嵌入场景接通菜单入口及快捷键 |
| 素材库导入与错误提示 | [data/library.ts](data/library.ts)、[ActiveConfirmDialog.tsx](components/ActiveConfirmDialog.tsx)、[LibraryMenuHeaderContent.tsx](components/LibraryMenuHeaderContent.tsx) | 导入确认使用异步编辑器弹窗，发布失败通过现有错误弹窗显示，不再调用浏览器 confirm/alert |
| React 18 类型兼容 | [TTDPreviewPanel.tsx](components/TTDDialog/TTDPreviewPanel.tsx)、[common.ts](components/TTDDialog/common.ts)、[useMermaidRenderer.ts](components/TTDDialog/hooks/useMermaidRenderer.ts) | 调整 RefObject 泛型以匹配 React 18；引用仍允许为空，不改变运行行为 |
| 快捷键提示 | [actions/shortcuts.ts](actions/shortcuts.ts)、[components/HelpDialog.tsx](components/HelpDialog.tsx) | 菜单及帮助同步显示新快捷键 |

普通 `Ctrl+C` / `Cmd+C` 仍复制可编辑元素，旧 `Shift+Alt+C` 不再复制 PNG。剪贴板图片写入仍受浏览器权限和安全上下文限制。

画布、SVG、PNG 和复制 PNG 使用同一份实例短头配置。`shortArrowheads` 通过渲染上下文传入几何生成，shape 和位图缓存也按该选项区分；切换时已有箭头重绘，不改元素、连线位置或场景版本。`.excalidraw` JSON 不保存此用户设置，交给其他编辑器打开时按它自身规则显示。组件这两个功能属性默认关闭，宿主从账户配置显式传入项目默认开启值。

### 连线交互优化

`arrowBindingOptimization` 仅改变普通直线、曲线箭头的新建拖拽和单端点编辑。目标内部和边缘都认可真实绑定，默认使用 `orbit` 将端点停在轮廓外；拖拽未松手时按住 Ctrl 使用 `inside`，松开 Ctrl 即恢复轮廓。按下/释放 Ctrl 时使用最后坐标重算，鼠标无需移动。鼠标松手时仍按 Ctrl，则内部绑定保留；之后释放 Ctrl 不修改已完成箭头。目标的 `boundElements`、箭头的 binding/fixedPoint 和端点同时更新，移动、缩放或旋转目标仍会跟随。

Alt 保持上游内部连接，Meta/Cmd 及组合键优先沿用上游规则；用户主动关闭绑定时不会强制开启。整条箭头或多个端点一起移动、多段点击绘制、折线箭头沿用上游行为。两端同一目标、嵌套/重叠元素及路径穿过其他元素不提供自动避障。极短箭头有有效轮廓交点时优先保持轮廓；无法形成外侧连线的特殊几何仍沿原规则。

实现位于 [App.tsx](components/App.tsx) 的实例手势状态、[binding.ts](lib/element/src/binding.ts) 的策略和轮廓回退，以及 [linearElementEditor.ts](lib/element/src/linearElementEditor.ts) 的端点更新。pointercancel、Esc、失焦、手势结束清理临时 Ctrl 状态；初始化、导入及 resetScene 均保留宿主属性，不从场景注入用户设置。所有新增 AppState 字段的 storage 配置均关闭。

账户和工作空间的输入、删除确认及冲突草稿舍弃使用宿主的 [AppDialog](../../src/components/AppDialog.vue)；刷新或关闭页面时的未保存提醒仍由浏览器提供。

Nunito、规整线条、隐藏 “Excalidraw links” 及工具栏底部布局，继续由 [Vue 包装组件](../../src/components/ExcalidrawCanvas.client.vue) 配置。采样倍率菜单由 [canvasSampling.ts](../../src/components/canvasSampling.ts) 提供，通过编辑器的 `canvasSampling` 属性传入 `1`、`1.5` 或 `2`（默认 `1`）。采样与渲染设置由宿主按账户保存到后端，不再自动读取无用户归属的旧 localStorage；不写入场景数据或撤销历史。

采样倍率乘以设备原生像素密度，应用于静态画布、交互层、新元素层及元素缓存；倍率变化会使元素与链接图标缓存重新生成。高倍率使用浏览器平滑缩小显示，画布 CSS 尺寸、坐标和导出分辨率保持原有语义。`2×` 的画布像素数约为 `1×` 的四倍，内存和渲染成本随之增加；元素缓存仍受上游尺寸上限限制。

渲染改动主要位于 [App.tsx](components/App.tsx)、[canvases/](components/canvases/)、[renderElement.ts](lib/element/src/renderElement.ts) 和 [staticScene.ts](renderer/staticScene.ts)。导出不传屏幕采样密度，继续使用原来的导出逻辑。

## 渲染实验开关

[canvasRenderingOptions.ts](../../src/components/canvasRenderingOptions.ts) 提供选项定义，账户菜单由宿主管理，通过 `canvasRenderingOptions` 属性传给编辑器。全部开关默认关闭，关闭后保持原有采样策略；“恢复调试默认”还会将采样倍率恢复为 `1×`。设置不写入场景、撤销历史或导出配置。

| 开关 | 作用与限制 |
| --- | --- |
| 缓存位图平滑 | 缓存合成时允许平滑缩放，可能减少锯齿，也可能让文字变软 |
| 高质量平滑 | 依赖缓存位图平滑，请求浏览器使用高质量插值；浏览器可能不表现出明显差别 |
| 文字直接绘制 | 绕过文字位图缓存，直接绘制到主画布；增加重绘工作量 |
| 简单图形直接绘制 | 矩形、椭圆、菱形、线条和无文字箭头绕过位图缓存；带文字箭头仍走原逻辑以保留文字留白 |
| 绘制位置对齐像素 | 未旋转元素的绘制起点对齐画布像素，最大偏移半个画布像素；不修改元素坐标，也不保证两侧边缘同时对齐 |
| 始终平滑显示画布 | 在 `1×` 时也使用 CSS 平滑显示；`1.5×` 和 `2×` 本来就采用该策略 |

这些选项用于比较 Canvas 渲染组合，没有引入 HTML/SVG 显示层。直接绘制的元素不经过对应位图缓存，其效果不会再受该缓存的平滑开关控制。几何和文字绘制仍调用上游绘制函数，导出继续使用独立路径。

## 构建适配与依赖

上游包原本由 Yarn monorepo 构建。本仓库改用 pnpm，并在 [build.mjs](build.mjs) 中保留 esbuild 双产物构建方式，不依赖上游根目录脚本和环境文件。构建中关闭上游统计追踪，保留素材库相关地址。字体继续使用上游默认 CDN。

为减小源码接入时的兼容变更，编辑器暂时保留上游 TypeScript 5.9.3、esbuild 0.19.10、esbuild-sass-plugin 2.16.0 和 Sass 1.51.0；Vite 5 与 Node 18 类型仅供编辑器旧工具链的类型检查。宿主应用使用 Nuxt 4、Vite 8、TypeScript 6 和 Node 类型。运行环境以[根目录 README](../../README.md#本地启动)为准；Node 类型版本不决定运行时版本。

严格的 pnpm 依赖隔离还要求显式声明 `csstype`、`@types/lodash.throttle` 和 utils 使用的 `points-on-curve`，这些声明已补齐。React 运行时共享宿主的 18.3.1；不新增另一份 React。

## 验证与更新上游

构建通过后，分别在 Nuxt 开发页面和本地 Worker 提供的生产页面检查（启动方式见[根目录 README](../../README.md#本地启动)）：新图形为规整线条、文字为 Nunito、箭头头部缩短；`Ctrl+C` 复制元素而 `Ctrl+Shift+C` 复制 PNG；外链菜单组隐藏，工具栏在底部且弹层向上展开。切换采样倍率后检查已有图形、新绘制图形及选择框位置，重登录或同账户换浏览器检查设置从服务端恢复；比较各倍率下复制 PNG 的尺寸，确认导出设置独立生效。修改渲染逻辑时还应比较 SVG/PNG 导出与画布外观。

新增功能可以运行 [arrowFlags.browser.mjs](tests/arrowFlags.browser.mjs) 做独立 Chromium 检查。先执行 `pnpm build:editor`；测试会在临时目录构建页面、启动回环服务，不使用账户或后端，并阻止外部请求。Playwright 是可选测试工具，未加入产品依赖，可在独立目录安装：

```sh
mkdir -p /tmp/excalidraw-browser-tests
printf '{"private":true}\n' > /tmp/excalidraw-browser-tests/package.json
pnpm --dir /tmp/excalidraw-browser-tests add playwright
pnpm --dir /tmp/excalidraw-browser-tests exec playwright install chromium
# 回到仓库根目录执行；也可用 CHROMIUM_PATH 指定已有 Chromium。
PLAYWRIGHT_MODULE=/tmp/excalidraw-browser-tests/node_modules/playwright/index.mjs \
  node packages/excalidraw/tests/arrowFlags.browser.mjs
```

断言覆盖初始化、默认轮廓和静止 Ctrl 切换、内部起点连接空白、开关关闭、三点曲线单端编辑、旋转轮廓、SVG/PNG、无元素版本变化及 JSON 排除设置，以及 resetScene 保留实例设置。

更新时先将目标上游版本获取到临时目录，对照 [UPSTREAM.json](UPSTREAM.json) 中的旧提交审查差异，再合入这些源码目录。保留本文列出的本地定制、构建脚本和依赖适配，更新来源记录与锁文件，重新执行构建和浏览器验证。不要用新版目录直接覆盖本地修改。
