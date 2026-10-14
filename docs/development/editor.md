# 编辑器

[返回开发者指南](readme.md)

宿主通过 [ExcalidrawCanvas.client.vue](../../src/components/ExcalidrawCanvas.client.vue) 将 React 编辑器挂到 Vue 页面。编辑器源码位于 `packages/excalidraw/`，通过 workspace 依赖接入；来源、定制位置和升级方式统一记录在[编辑器源码维护说明](../../packages/excalidraw/README.md)。

## 调整绘图交互

连线绑定、默认字体与线条、箭头头部和渲染策略主要在浏览器内执行，用例本身没有专属 API。统一设置面板通过[账户设置](user-settings.md)持久化选项，包装组件将选项传给编辑器实例。

“Ctrl 点击多选”默认开启，通过 `ctrlMultiSelect` 属性控制选择工具下的左键累加与取消选择，普通画布与协作画布均即时生效。关闭后恢复 Ctrl 穿透分组选择；Ctrl+Alt 套索、⌘、线段点编辑及其他工具保留原行为。该实现只调整选择分支，不伪造 Shift 事件，因此不影响绘图角度、缩放和快捷键。独立使用编辑器而未传此属性时保持上游行为。

修改编辑器菜单与宿主属性从包装组件开始，调整设置内容从 [SettingsPanel.vue](../../src/components/SettingsPanel.vue) 和 [settingsControls.ts](../../src/lib/settingsControls.ts) 开始；修改编辑器内部行为，按[本地定制位置](../../packages/excalidraw/README.md#本仓库的定制)定位手势、几何和渲染代码。修改设置字段时，同时检查共享类型、默认值、后端完整配置校验和设置资源测试。

打开画布时，前端根据浏览器 UA 为移动设备默认选择抓手（平移工具），桌面保留指针默认行为；iPad 的桌面 UA 结合多点触摸识别，不将窄窗口或普通触摸电脑视为移动设备。判断只用于初始化，不控制后续工具选择；版本校验结束、远端更新和重连不重新设置工具。用户手动选择的工具通过当前账号内该画布的内存 `editorContext` 在切换画布时保留；刷新页面或重新登录后恢复设备默认工具，工具不写入服务端画布或共享给其他编辑者。入口见 [editorTools.ts](../../src/lib/editorTools.ts) 和两个画布包装组件。

## 收藏与复用颜色

描边、填充和画布背景的原生颜色弹层共用「我的色板」。在原有颜色输入框输入颜色，或选取现有颜色后，点击「收藏当前颜色」；点击收藏色即可应用，点击旁边的移除按钮可取消收藏。支持原生输入框接受的颜色格式，保存时统一为十六进制或透明色；重复颜色不会新增，每个账号最多收藏 24 色。Tab 可从原有颜色输入框进入色板，Enter/Space 应用，Delete/Backspace 移除聚焦的收藏色，Escape 关闭弹层；删除收藏不修改画布元素。

色板是浏览器中的个人偏好：两个宿主组件通过 `customColorPaletteStorageKey` 传入包含账号 ID 的 localStorage key，跨工作区、画布和刷新复用，同一浏览器其他标签的修改通过 `storage` 事件更新。不同账号使用不同 key，未登录的公开查看页面不启用色板。颜色不会进入画布数据、协作消息或后端账户设置，也不跨设备同步。浏览器存储不可写时，当前编辑器仍可使用临时色板，并显示保存失败提示；关闭或切换编辑器后可能丢失这部分临时颜色。

入口为 [SavedColorPalette.tsx](../../packages/excalidraw/components/ColorPicker/SavedColorPalette.tsx)，原生 [Picker.tsx](../../packages/excalidraw/components/ColorPicker/Picker.tsx) 复用现有 `onChange` 颜色动作，持久化数据的校验和数量限制见 [savedColors.ts](../../packages/excalidraw/components/ColorPicker/savedColors.ts)。该功能由宿主显式传 key 开启，独立使用编辑器时保留上游行为。持久化回归见 [saved-colors.test.ts](../../tests/unit/saved-colors.test.ts) 与 [saved-colors.spec.ts](../../tests/browser/saved-colors.spec.ts)。

## 导入导出与复制

画布文件导入、SVG/PNG 导出和复制在浏览器内执行，没有单独的导入导出 API；导入导致的画布内容变化随后进入[保存内容](canvases.md#保存内容)流程。个人素材库导入后走[保存素材库](library.md#保存素材库)。

调整文件序列化或导出入口，参见 [data/json.ts](../../packages/excalidraw/data/json.ts) 和 [data/index.ts](../../packages/excalidraw/data/index.ts)；复制 PNG 的本地快捷键修改见 [actionClipboard.tsx](../../packages/excalidraw/actions/actionClipboard.tsx)。导出外观和屏幕渲染设置的边界见[源码维护说明](../../packages/excalidraw/README.md)。

## 验证入口

修改编辑器源码后先重建编辑器，再按[验证与更新上游](../../packages/excalidraw/README.md#验证与更新上游)运行 Chromium 检查。宿主页面仍需浏览器验收，确认 React 挂载、菜单选项、文件导入、图片剪贴板及 SVG/PNG 导出；修改手势或渲染时比较屏幕与导出结果。
