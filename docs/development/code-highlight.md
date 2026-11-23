# 代码块语法高亮

[返回目录](../../README.md#目录)

画布文字中的代码块按围栏语言着色，编辑态、画布绘制和 SVG/PNG 导出使用同一套语义类别与颜色。颜色只用于显示，不写入文档；持久化仍是纯文本代码加语言名。

## 输入与识别

在文字编辑器中输入三个反引号后按 Enter 进入代码块，可在反引号后写语言名（如 `ts`、`python`、`sql`），只取第一个词。语言名大小写不敏感，常见别名与正式名等价：`js`/`jsx` → JavaScript，`py` → Python，`sh`/`shell`/`zsh` → Bash，`yml` → YAML，`html`/`vue`/`svg` → XML，`toml`/`conf` → INI，`cs`/`c#` → C#，`c++`/`cc` → C++，等等。

未写语言、语言不在支持列表或围栏内容为空时按纯文本显示，不报错也不阻塞编辑。

## 支持的语言

Bash、C、C++、C#、CSS/SCSS、Diff、Dockerfile、Go、INI/TOML、Java、JavaScript、JSON、Kotlin、Markdown、PHP、Python、Ruby、Rust、SQL、Swift、TypeScript、XML/HTML、YAML。

每种语言对应一个 `highlight.js` 语法模块，只在首次遇到该语言时下载，不进入主包。

## 按需加载与回退

[codeHighlight.ts](../../packages/excalidraw/lib/element/src/codeHighlight.ts) 维护语言表、别名映射和语义着色类别（keyword、string、comment、number、literal、function、type、attr、tag、variable、meta、section）。首次出现某种语言时：

1. 代码块先按纯文本显示，编辑、画布和导出均可用。
2. 语法模块加载完成后自动通知重绘，已显示的代码块着色。
3. 同一语言与同一段代码复用缓存结果，不重复解析。
4. 加载失败时本次会话保持纯文本；刷新后重新尝试。

语法解析在浏览器内完成，不请求后端，也没有代码高亮专属接口或数据库字段。

## 渲染一致性

编辑态、Canvas 绘制、SVG 导出和 PNG 导出共用 [richTextLayout.ts](../../packages/excalidraw/lib/element/src/richTextLayout.ts) 的布局测量与着色区间，颜色取自 `codeTokenColor()`，因此同一代码块在四处外观一致。浅色主题使用固定色值，深色界面由画布的暗色滤镜统一处理；标点与运算符沿用元素本身颜色。

代码块背景、缩进与行高属于富文本布局，不随语言变化；高亮只改变文字颜色。

## 持久化与兼容

元素仍保存纯文本 `originalText` 和 `richText: { version: 2, doc }` 结构，代码块只记录代码文本与语言名，不保存颜色或 token。旧客户端读到含代码块的文档时按纯文本显示，不丢失内容；保存能力版本仍为 `textFormatVersion: 3`，规则见[编辑富文本](editor.md#编辑富文本)。

## 验证入口

- [code-highlight.test.ts](../../tests/unit/code-highlight.test.ts)：别名识别、区间不重叠、未知语言回退、缓存复用。
- [code-highlight.spec.ts](../../tests/browser/code-highlight.spec.ts)：编辑态着色与 SVG 导出一致。
- [rich-text-layout.spec.ts](../../tests/browser/rich-text-layout.spec.ts)：代码块布局与导出的通用回归。

修改语言表或着色类别后重建编辑器，再跑上述用例；新增语言时同时确认别名不冲突、导出颜色一致。
