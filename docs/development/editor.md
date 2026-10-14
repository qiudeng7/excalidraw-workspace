# 编辑器

[返回开发者指南](readme.md)

宿主通过 [ExcalidrawCanvas.client.vue](../../src/components/ExcalidrawCanvas.client.vue) 将 React 编辑器挂到 Vue 页面。编辑器源码位于 `packages/excalidraw/`，通过 workspace 依赖接入；来源、定制位置和升级方式统一记录在[编辑器源码维护说明](../../packages/excalidraw/README.md)。

## 调整绘图交互

连线绑定、默认字体与线条、箭头头部和渲染策略主要在浏览器内执行，用例本身没有专属 API。统一设置面板通过[账户设置](user-settings.md)持久化选项，包装组件将选项传给编辑器实例。

“Ctrl 点击多选”默认开启，通过 `ctrlMultiSelect` 属性控制选择工具下的左键累加与取消选择，普通画布与协作画布均即时生效。关闭后恢复 Ctrl 穿透分组选择；Ctrl+Alt 套索、⌘、线段点编辑及其他工具保留原行为。该实现只调整选择分支，不伪造 Shift 事件，因此不影响绘图角度、缩放和快捷键。独立使用编辑器而未传此属性时保持上游行为。

修改编辑器菜单与宿主属性从包装组件开始，调整设置内容从 [SettingsPanel.vue](../../src/components/SettingsPanel.vue) 和 [settingsControls.ts](../../src/lib/settingsControls.ts) 开始；修改编辑器内部行为，按[本地定制位置](../../packages/excalidraw/README.md#本仓库的定制)定位手势、几何和渲染代码。修改设置字段时，同时检查共享类型、默认值、后端完整配置校验和设置资源测试。

打开画布时，前端根据浏览器 UA 为移动设备默认选择抓手（平移工具），桌面保留指针默认行为；iPad 的桌面 UA 结合多点触摸识别，不将窄窗口或普通触摸电脑视为移动设备。判断只用于初始化，不控制后续工具选择；版本校验结束、远端更新和重连不重新设置工具。用户手动选择的工具通过当前账号内该画布的内存 `editorContext` 在切换画布时保留；刷新页面或重新登录后恢复设备默认工具，工具不写入服务端画布或共享给其他编辑者。入口见 [editorTools.ts](../../src/lib/editorTools.ts) 和两个画布包装组件。

## 导入导出与复制

画布文件导入、SVG/PNG 导出和复制在浏览器内执行，没有单独的导入导出 API；导入导致的画布内容变化随后进入[保存内容](canvases.md#保存内容)流程。个人素材库导入后走[保存素材库](library.md#保存素材库)。

调整文件序列化或导出入口，参见 [data/json.ts](../../packages/excalidraw/data/json.ts) 和 [data/index.ts](../../packages/excalidraw/data/index.ts)；复制 PNG 的本地快捷键修改见 [actionClipboard.tsx](../../packages/excalidraw/actions/actionClipboard.tsx)。导出外观和屏幕渲染设置的边界见[源码维护说明](../../packages/excalidraw/README.md)。

## 验证入口

修改编辑器源码后先重建编辑器，再按[验证与更新上游](../../packages/excalidraw/README.md#验证与更新上游)运行 Chromium 检查。宿主页面仍需浏览器验收，确认 React 挂载、菜单选项、文件导入、图片剪贴板及 SVG/PNG 导出；修改手势或渲染时比较屏幕与导出结果。
