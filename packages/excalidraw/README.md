# 本地 Excalidraw 源码

本目录把 Excalidraw 编辑器及其内部依赖纳入当前 Git 仓库维护。Demo 通过 `workspace:*` 使用这里的源码构建产物，不再依赖 npm 上的编辑器包或 pnpm patch。

## 来源与目录

源码来自 [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw)，基线为 `v0.18.1`，提交 `a2ec2889babf7d2295469c6d90ebe77fae57df84`。精确来源保存在 [UPSTREAM.json](UPSTREAM.json)，上游 MIT 许可证保存在 [LICENSE](LICENSE)；各字体目录中也保留了上游随附的许可文件。

| 目录 | 内容 |
| --- | --- |
| [当前目录](./) | React 编辑器、渲染器、菜单、字体和语言资源 |
| [lib/math/](lib/math/) | 几何计算与数学类型 |
| [lib/utils/](lib/utils/) | 碰撞、导出等工具函数 |

三个包统一由仓库根目录的 [pnpm-workspace.yaml](../../pnpm-workspace.yaml) 管理，`math` 和 `utils` 仍是独立 workspace 包，通过 `workspace:*` 引用。上游路径与本地路径的对应关系记录在 `UPSTREAM.json` 的 `localPaths` 中；上游包说明保留在 [README.upstream.md](README.upstream.md)。

这些目录是普通源码目录，没有嵌套 `.git` 或 submodule。上游的网站应用、示例、文档站和发布工作流未引入；编辑器包里的上游测试保留供后续维护参考，当前仓库尚未接入其完整测试运行环境。

## 构建和开发

在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 先构建本地编辑器，再启动 Demo。其余命令：

```sh
pnpm build:editor # 只构建三个源码包所需的编辑器 JS、CSS、字体和类型声明
pnpm build        # 构建编辑器、检查 Demo 类型并生成 dist/
pnpm preview      # 预览 Demo 的生产构建
```

编辑器的开发版和生产版由同一份 TypeScript 源码生成，分别输出到 `packages/excalidraw/dist/dev` 和 `packages/excalidraw/dist/prod`。内部 math/utils 实现打包进编辑器，类型声明同步到对应包的 `dist/`，防止 Vue 宿主以自己的 JSX 规则检查 React 源码。生成的 `dist/` 均不提交。

修改编辑器后重新运行 `pnpm build:editor`。连续调整渲染代码时，可在另一个终端运行：

```sh
pnpm --filter @excalidraw/excalidraw build:watch
```

这个命令监听并重建 JavaScript/CSS，不重新生成类型声明；涉及公共类型的修改仍需运行完整的 `pnpm build:editor`。若浏览器仍使用旧依赖缓存，重启 `pnpm dev --force`。

## 本仓库的定制

| 定制 | 源码位置 | 行为 |
| --- | --- | --- |
| 普通开口箭头头部 | [element/bounds.ts](element/bounds.ts) 的 `getArrowheadSize`、`getArrowheadAngle` | 最大侧翼长度 25 → 14，单侧角度 20° → 28°；其他头部类型和短箭头限制保留 |
| 复制 PNG 快捷键 | [actions/actionClipboard.tsx](actions/actionClipboard.tsx) 的 `actionCopyAsPng` | Windows/Linux 用 `Ctrl+Shift+C`，macOS 用 `Cmd+Shift+C`，排除 Alt |
| 快捷键提示 | [actions/shortcuts.ts](actions/shortcuts.ts)、[components/HelpDialog.tsx](components/HelpDialog.tsx) | 菜单及帮助同步显示新快捷键 |
| React 18 类型兼容 | [TTDDialogOutput.tsx](components/TTDDialog/TTDDialogOutput.tsx)、[common.ts](components/TTDDialog/common.ts) | 调整 `RefObject` 的泛型，引用仍允许为空，不改变运行行为 |

普通 `Ctrl+C` / `Cmd+C` 仍复制可编辑元素，旧 `Shift+Alt+C` 不再复制 PNG。剪贴板图片写入仍受浏览器权限和安全上下文限制。

画布、SVG 和 PNG 使用同一套箭头几何生成逻辑。但 `.excalidraw` 文件不保存这里定制的头部尺寸，交给原版编辑器打开仍按原版规则显示。

Nunito、规整线条、隐藏 “Excalidraw links” 及工具栏底部布局，继续由 [Vue 包装组件](../../src/components/ExcalidrawCanvas.vue) 配置。采样倍率设置尚未实现。

## 构建适配与依赖

上游包原本由 Yarn monorepo 构建。本仓库改用 pnpm，并在 [build.mjs](build.mjs) 中保留 esbuild 双产物构建方式，不依赖上游根目录脚本和环境文件。构建中关闭上游统计追踪，保留素材库相关地址。字体继续使用上游默认 CDN。

为减小源码接入时的兼容变更，编辑器暂时保留上游 TypeScript 4.9.4、esbuild 0.19.10、esbuild-sass-plugin 2.16.0 和 Sass 1.51.0；Vite 5 与 Node 18 类型仅供编辑器旧工具链的类型检查。Demo 仍使用自己的 Vite 8、TypeScript 6 和 Node 26 类型。实际运行已在 Node 26.8.1 验证。

严格的 pnpm 依赖隔离还要求显式声明 `csstype`、`@types/lodash.throttle` 和 utils 使用的 `points-on-curve`，这些声明已补齐。React 运行时共享宿主的 18.3.1；不新增另一份 React。

## 验证与更新上游

构建通过后，分别在开发页面和 `pnpm preview` 页面检查：新图形为规整线条、文字为 Nunito、箭头头部缩短；`Ctrl+C` 复制元素而 `Ctrl+Shift+C` 复制 PNG；外链菜单组隐藏，工具栏在底部且弹层向上展开。修改渲染逻辑时还应比较 SVG/PNG 导出与画布外观。

当前已运行编辑器源码类型检查、Demo 类型检查和生产构建，以及主要浏览器交互检查；尚未运行上游完整测试套件，也未对 SVG/PNG 文件导出做完整视觉回归。

更新时先将目标上游版本获取到临时目录，对照 [UPSTREAM.json](UPSTREAM.json) 中的旧提交审查差异，再合入这三个目录。保留本节列出的本地定制、构建脚本和依赖适配，更新来源记录与锁文件，重新执行构建和浏览器验证。不要用新版目录直接覆盖本地修改。
