# 编辑器

[返回目录](../../README.md#目录)

宿主通过 [ExcalidrawCanvas.client.vue](../../src/components/ExcalidrawCanvas.client.vue) 将 React 编辑器挂到 Vue 页面。编辑器源码位于 `packages/excalidraw/`，通过 workspace 依赖接入；来源、定制位置和升级方式统一记录在[编辑器源码维护说明](../../packages/excalidraw/README.md)。

## 调整绘图交互

新图形默认使用规整实线、2px 线宽，选择填充颜色后使用纯色填充；新文字默认使用 Nunito。导入和已有元素保留自己的样式。编辑器包含命令面板、套索、填充桶和自动识别形状工具，工具栏默认位于画布底部，提示显示在工具栏上方；关闭“编辑器”中的“工具栏置底”可切换到顶部。编辑器菜单的“跳转”分组可前往首页和关于页。

连线绑定、默认字体与线条、箭头头部和渲染策略主要在浏览器内执行，用例本身没有专属 API。统一设置面板通过[账户设置](user-settings.md)持久化选项，包装组件将选项传给编辑器实例。

“Ctrl 点击多选”默认开启，通过 `ctrlMultiSelect` 属性控制选择工具下的左键累加与取消选择，普通画布与协作画布均即时生效。关闭后恢复 Ctrl 穿透分组选择；Ctrl+Alt 套索、⌘、线段点编辑及其他工具保留原行为。该实现只调整选择分支，不伪造 Shift 事件，因此不影响绘图角度、缩放和快捷键。独立使用编辑器而未传此属性时保持上游行为。

修改编辑器菜单与宿主属性从包装组件开始，调整设置内容从 [SettingsPanel.vue](../../src/components/SettingsPanel.vue) 和 [settingsControls.ts](../../src/lib/settingsControls.ts) 开始；修改编辑器内部行为，按[本地定制位置](../../packages/excalidraw/README.md#本仓库的定制)定位手势、几何和渲染代码。修改设置字段时，同时检查共享类型、默认值、后端完整配置校验和设置资源测试。

打开画布时，前端根据浏览器 UA 为移动设备默认选择抓手（平移工具），桌面保留指针默认行为；iPad 的桌面 UA 结合多点触摸识别，不将窄窗口或普通触摸电脑视为移动设备。判断只用于初始化，不控制后续工具选择；版本校验结束、远端更新和重连不重新设置工具。用户手动选择的工具通过当前账号内该画布的内存 `editorContext` 在切换画布时保留；刷新页面或重新登录后恢复设备默认工具，工具不写入服务端画布或共享给其他编辑者。入口见 [editorTools.ts](../../src/lib/editorTools.ts) 和两个画布包装组件。

## 编辑富文本

双击画布文字后使用 ProseMirror 直接编辑格式化内容，再次进入编辑仍显示格式化结果，不提供格式工具栏。输入支持 `**粗体**`、`__粗体__`、`*斜体*`、`_斜体_`、`` `行内代码` ``、`~~删除线~~` 和 `[链接](https://example.com)`；段落开头输入 `# ` 至 `###### `、`- `、`1. ` 或 `> `，分别转为标题、无序列表、有序列表或引用。输入三个反引号后按 Enter 进入代码块，可在反引号后附语言名称，但不做语法高亮。标题字号按文字元素的基础字号缩放；表格、图片和 HTML 不参与格式转换。

普通粘贴通过官方 `prosemirror-markdown` 模块解析 Markdown，`Ctrl / ⌘ Shift V` 保留字面文本；代码块内粘贴始终保留字面内容。打开已有普通文字不会重新解释其中的 Markdown 标记。

Enter 按所在结构拆分段落、继续列表或在代码块内换行；空列表项按 Enter 退出列表，Tab / Shift Tab 调整列表缩进。Shift Enter 插入软换行，代码块末尾按向下方向键进入后续段落。Escape 或 `Ctrl / ⌘ Enter` 完成编辑。`Ctrl / ⌘ B`、`I`、`E` 切换粗体、斜体、行内代码，`Ctrl / ⌘ \` 清除选区行内格式；输入转换后按 Backspace 或撤销可恢复字面标记。

自由文字、形状内文字、箭头标签和便签沿用原生文字定位、缩放、旋转及容器调整流程。编辑 DOM 与静态测量共用作用域样式，统一段落边距、字号和行高；离开编辑后由 Canvas 绘制，SVG 与 PNG 共用文字、列表标记、引用线和代码背景的布局测量。字体随编辑器构建产物由本站 `/editor-assets/fonts/` 提供，字体加载完成后清除测量缓存并重新绘制。

元素保留纯文本 `originalText`，实际修改后以 `richText: { version: 2, doc }` 保存段落、块结构和行内样式。读取同时支持 v1 与 v2，仅打开再关闭不会升级旧文档，也不批量迁移画布或历史版本。元素复制、个人素材库、`.excalidraw` 导入导出均保留该字段；未知格式版本显示纯文本投影并阻止编辑，避免静默丢失原始结构。

当前客户端写入声明 `textFormatVersion: 2`；保存与协作同时校验传入内容及已有内容，拒绝只支持 v1 的旧客户端覆盖包含 v2 的场景或素材库。保存、协作、恢复和素材库共用结构校验及纯文本投影规则。相关接口沿用[画布保存](canvases.md#保存内容)、[素材库保存](library.md#保存素材库)和[协作更新](collaboration.md)，没有新增数据库表或富文本专属 API。

协作仍按整个文字元素合并；另一会话的版本胜出、删除元素或撤销编辑权限时，结束当前编辑并保留可恢复的本地副本。恢复会创建新元素，不覆盖远端胜出的内容；恢复入口也提供下载副本。

副本在当前浏览器内按账号、分享凭证哈希与浏览器标签隔离，只有成功写入浏览器后，刷新或重新打开已失效的原始分享链接时才仍可下载。浏览器配额不足、禁止存储或恢复作用域不可用时，会明确提示「尚未写入浏览器，请刷新前下载」，并保留当前页面的内存副本和下载入口；新的写入失败不会删除已存在的旧副本。不会保存明文分享凭证，也不会覆盖另一个标签的副本。失效链接拒绝页只提供已持久化的本地副本下载，不挂载编辑器或读取远端场景。

实现入口为 [richTextWysiwyg.ts](../../packages/excalidraw/wysiwyg/richTextWysiwyg.ts) 与 [richTextEditor.ts](../../packages/excalidraw/wysiwyg/richTextEditor.ts)。共享校验见 [richTextDocument.ts](../../packages/excalidraw/lib/element/src/richTextDocument.ts)，Canvas/SVG 布局见 [richTextLayout.ts](../../packages/excalidraw/lib/element/src/richTextLayout.ts)，后端兼容保护见 [richText.ts](../../server/utils/richText.ts)。回归入口为 `tests/browser/rich-text.spec.ts`、标签页中的持久化与文件往返用例，以及真实协作测试中的远端胜出、删除和撤权恢复用例。

## 收藏与复用颜色

描边、填充和画布背景的原生颜色弹层共用「我的色板」。在原有颜色输入框输入颜色，或选取现有颜色后，点击「收藏当前颜色」；点击收藏色即可应用，点击旁边的移除按钮可取消收藏。支持原生输入框接受的颜色格式，保存时统一为十六进制或透明色；重复颜色不会新增，每个账号最多收藏 24 色。Tab 可从原有颜色输入框进入色板，Enter/Space 应用，Delete/Backspace 移除聚焦的收藏色，Escape 关闭弹层；删除收藏不修改画布元素。

色板是浏览器中的个人偏好：两个宿主组件通过 `customColorPaletteStorageKey` 传入包含账号 ID 的 localStorage key，跨工作区、画布和刷新复用，同一浏览器其他标签的修改通过 `storage` 事件更新。不同账号使用不同 key，未登录的公开查看页面不启用色板。颜色不会进入画布数据、协作消息或后端账户设置，也不跨设备同步。浏览器存储不可写时，当前编辑器仍可使用临时色板，并显示保存失败提示；关闭或切换编辑器后可能丢失这部分临时颜色。

入口为 [SavedColorPalette.tsx](../../packages/excalidraw/components/ColorPicker/SavedColorPalette.tsx)，原生 [Picker.tsx](../../packages/excalidraw/components/ColorPicker/Picker.tsx) 复用现有 `onChange` 颜色动作，持久化数据的校验和数量限制见 [savedColors.ts](../../packages/excalidraw/components/ColorPicker/savedColors.ts)。该功能由宿主显式传 key 开启，独立使用编辑器时保留上游行为。持久化回归见 [saved-colors.test.ts](../../tests/unit/saved-colors.test.ts) 与 [saved-colors.spec.ts](../../tests/browser/saved-colors.spec.ts)。

## 导入导出与复制

普通 `Ctrl+C` 复制可编辑元素，`Ctrl+Shift+C` 复制 PNG，可粘贴到支持图片的应用；macOS 使用 Cmd 代替 Ctrl。图片剪贴板需要浏览器权限和 HTTPS 或 localhost 安全上下文。编辑器菜单提供文件导入、导出，可保留独立备份。

画布文件导入、SVG/PNG 导出和复制在浏览器内执行，没有单独的导入导出 API；导入导致的画布内容变化随后进入[保存内容](canvases.md#保存内容)流程。个人素材库导入后走[保存素材库](library.md#保存素材库)。

调整文件序列化或导出入口，参见 [data/json.ts](../../packages/excalidraw/data/json.ts) 和 [data/index.ts](../../packages/excalidraw/data/index.ts)；复制 PNG 的本地快捷键修改见 [actionClipboard.tsx](../../packages/excalidraw/actions/actionClipboard.tsx)。导出外观和屏幕渲染设置的边界见[源码维护说明](../../packages/excalidraw/README.md)。

## 验证入口

修改编辑器源码后先重建编辑器，再按[验证与更新上游](../../packages/excalidraw/README.md#验证与更新上游)运行 Chromium 检查。宿主页面仍需浏览器验收，确认 React 挂载、菜单选项、文件导入、图片剪贴板及 SVG/PNG 导出；修改手势或渲染时比较屏幕与导出结果。
