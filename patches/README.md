# Excalidraw 补丁说明

本目录保存对 `@excalidraw/excalidraw@0.18.1` 的定制：缩短普通箭头头部，并把复制 PNG 的快捷键改为 `Ctrl+Shift+C`。补丁由 pnpm 在安装依赖时自动应用，不需要手动修改 `node_modules`。

## 改了什么

| 修改 | 原行为 | 修改后 | 原因 |
| --- | --- | --- | --- |
| 普通开口箭头的头部尺寸 | 最大侧翼长度 25，单侧角度 20° | 最大侧翼长度 14，单侧角度 28° | 原箭头头部过长，改为更紧凑的外观 |
| 复制为 PNG | `Shift+Alt+C` | Windows/Linux：`Ctrl+Shift+C`；macOS：`Cmd+Shift+C` | 方便复制图片到聊天窗口和文档 |
| 快捷键提示 | 显示旧快捷键 | 菜单和帮助显示新快捷键 | 保持提示与实际操作一致 |

箭头修改仅针对 `arrow` 类型，其他箭头头部不变；短箭头仍受末段长度限制。画布、SVG 和 PNG 导出使用同一套箭头几何生成逻辑。`.excalidraw` 文件没有保存这组定制尺寸，交给原版编辑器打开时，仍按原版规则显示。

普通 `Ctrl+C` / `Cmd+C` 仍复制可编辑元素数据。新快捷键要求未按 Alt；旧的 `Shift+Alt+C` 不再触发复制 PNG。剪贴板图片写入仍受浏览器权限与安全上下文限制。

Nunito 字体、规整线条等默认选项，以及隐藏 “Excalidraw links” 菜单组，通过 [Vue 包装组件](../src/components/ExcalidrawCanvas.vue) 配置，不属于此补丁。

## 怎样阅读补丁

补丁文件：[Excalidraw 0.18.1 补丁](@excalidraw__excalidraw@0.18.1.patch)。优先阅读 `dist/dev` 的差异：

| 包内文件 | 定位入口 | 修改内容 |
| --- | --- | --- |
| `dist/dev/chunk-4FTI6OG3.js` | `getArrowheadSize`、`getArrowheadAngle` | 只修改 `case "arrow"` 的返回值 |
| `dist/dev/index.js` | `actionCopyAsPng.keyTest` | 使用 `KEYS.CTRL_OR_CMD`、Shift，排除 Alt |
| `dist/dev/index.js` | `shortcutMap.copyAsPng`、`HelpDialog` | 更新快捷键提示 |
| `dist/prod/chunk-K2UTITRG.js`、`dist/prod/index.js` | 对应压缩后的逻辑 | 同步开发版本的修改 |

npm 包发布的是构建产物，生产文件的一行可能包含大量代码，因此只改几个值也会产生很长的 diff。文件名及压缩变量名与当前版本绑定，升级时不要照搬。补丁未同步修改 source map，调试器映射回的原始源码可能仍显示旧值；核查时以实际运行的 JavaScript 为准。

## 安装与验证

在项目根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

打开 `/draw`，验证新建箭头头部缩短；选中元素后，普通复制仍可粘贴回画布继续编辑，`Ctrl+Shift+C` 可粘贴 PNG 到支持图片的应用。macOS 使用 Cmd。菜单及帮助应显示新快捷键，旧快捷键不应触发复制 PNG。

再运行 `pnpm preview` 检查生产构建，并在修改箭头逻辑时分别导出 SVG、PNG，与画布外观对照。此前已验证开发和生产模式的 PNG 剪贴板写入；SVG/PNG 导出共享几何路径已核对源码，但尚未单独完成两种文件导出的视觉对照。

## 继续修改与升级

修改当前版本补丁时，在项目根目录运行：

```sh
pnpm patch @excalidraw/excalidraw@0.18.1
```

pnpm 会输出编辑目录，并在默认情况下带上现有补丁。修改该目录内的文件，同时处理 `dist/dev` 与 `dist/prod`，然后运行：

```sh
pnpm patch-commit <pnpm 输出的编辑目录>
```

这里的 `patch-commit` 只生成和登记补丁，不会执行 Git commit。完成后检查 diff，并执行上面的安装与验证。正在运行的 Vite 可能仍缓存旧依赖，停止后用 `pnpm dev --force` 重新启动。

升级 Excalidraw 时，先检查新版是否已提供对应配置或修复，再决定保留哪些修改。在可回退的工作区移除旧补丁登记（`pnpm patch-remove @excalidraw/excalidraw@0.18.1`），安装目标精确版本，再运行 `pnpm patch @excalidraw/excalidraw@<目标版本>`，定位新版逻辑并重新生成补丁。不要仅修改旧补丁的版本号或直接套用旧压缩变量名。

提交时一起保存 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、补丁文件和本说明。当前 Excalidraw 使用精确版本，避免依赖自动升级后遗漏补丁。
