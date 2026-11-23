import assert from "node:assert/strict";
import test from "node:test";
import {
  codeHighlightVersion,
  highlightCode,
  loadCodeLanguage,
  onCodeHighlightReady,
  resolveCodeLanguage,
} from "../../packages/excalidraw/lib/element/src/codeHighlight";

// 验证边界：只覆盖语言解析、按需加载与 token 区间。画布、编辑器和 SVG 着色依赖浏览器测量，由浏览器用例验证。

const languages = ["typescript", "javascript", "go"];

await Promise.all(languages.map(loadCodeLanguage));

test("按需加载：语法未就绪时先按纯文本，加载完成后自动通知并着色", async () => {
  assert.equal(
    highlightCode("def add(a, b):\n    return a + b", "python"),
    null,
  );

  const before = codeHighlightVersion();
  let notified = 0;
  const unsubscribe = onCodeHighlightReady(() => {
    notified += 1;
  });

  await loadCodeLanguage("py");
  unsubscribe();

  assert.equal(notified, 1);
  assert.ok(codeHighlightVersion() > before);
  assert.ok(highlightCode("def add(a, b):\n    return a + b", "py"));
});

test("TypeScript 代码块产出关键字、字符串与注释区间", () => {
  const code = 'const name: string = "demo"; // 说明';
  const tokens = highlightCode(code, "ts");

  assert.ok(tokens);
  const byText = new Map(
    tokens.map((token) => [code.slice(token.start, token.end), token.kind]),
  );

  assert.equal(byText.get("const"), "keyword");
  assert.equal(byText.get("// 说明"), "comment");
  assert.equal(byText.get('"demo"'), "string");
});

test("token 区间不重叠、不越界，且纯标点不着色", () => {
  const code = `if (a > 1) { return "x"; }`;
  const tokens = highlightCode(code, "js");

  assert.ok(tokens);

  for (const token of tokens) {
    assert.ok(token.start >= 0 && token.end <= code.length);
    assert.ok(token.start < token.end);
    assert.ok(!/^[^\p{L}\p{N}_$]+$/u.test(code.slice(token.start, token.end)));
  }

  for (let index = 1; index < tokens.length; index++) {
    assert.ok(tokens[index - 1].end <= tokens[index].start);
  }
});

test("未知语言与空代码退化为纯文本", () => {
  assert.equal(resolveCodeLanguage("brainfuck"), null);
  assert.equal(resolveCodeLanguage(undefined), null);
  assert.equal(highlightCode("print(1)", "brainfuck"), null);
  assert.equal(highlightCode("", "js"), null);
});

test("围栏语言只取第一个词，并识别常见别名", () => {
  assert.equal(resolveCodeLanguage("ts"), "typescript");
  assert.equal(resolveCodeLanguage("JS title=demo.js"), "javascript");
  assert.equal(resolveCodeLanguage("py"), "python");
  assert.equal(resolveCodeLanguage("unknown-lang"), null);
});

test("同一语言与代码复用缓存结果", () => {
  const code = "const value = 1;";

  assert.equal(highlightCode(code, "js"), highlightCode(code, "js"));
});
