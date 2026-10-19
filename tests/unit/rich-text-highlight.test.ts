// 验证真实 Markdown 解析、共享文档校验和恢复副本往返；恢复存储用内存替身，不包含浏览器输入事件或网络存储。
import assert from "node:assert/strict";
import test from "node:test";
import { parseRichTextMarkdown } from "../../packages/excalidraw/wysiwyg/richTextEditor";
import {
  isSupportedRichText,
  isRichTextV1,
  normalizeRichText,
  richTextPlainText,
  supportsRichTextWrite,
  richTextFromPlainText,
} from "../../packages/excalidraw/lib/element/src/richTextDocument";

test("Markdown 局部高亮与粗体、链接组合后通过校验且纯文本不含分隔符", () => {
  const parsed = {
    version: 2 as const,
    doc: parseRichTextMarkdown(
      "普通 ==重点 **粗体** [链接](https://example.test)== 结尾",
    ).toJSON(),
  };

  assert.ok(isSupportedRichText(parsed));
  const normalized = normalizeRichText(parsed);

  assert.equal(richTextPlainText(normalized), "普通 重点 粗体 链接 结尾");
  const content = normalized.doc.content[0].content!;

  assert.deepEqual(
    content.map((node: any) => [
      node.text,
      node.marks?.map((mark: any) => mark.type).sort() ?? [],
    ]),
    [
      ["普通 ", []],
      ["重点 ", ["highlight"]],
      ["粗体", ["bold", "highlight"]],
      [" ", ["highlight"]],
      ["链接", ["highlight", "link"]],
      [" 结尾", []],
    ],
  );
  assert.deepEqual(normalizeRichText(normalized), normalized);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), normalized);
  assert.equal(isRichTextV1({ ...normalized, version: 1 }), false);
});

test("未闭合、转义、行内代码、代码块和 HTML 不启用高亮或 HTML 格式", () => {
  for (const [source, plain] of [
    ["==未闭合", "==未闭合"],
    ["\\==转义==", "==转义=="],
    ["`==代码==`", "==代码=="],
    ["```\n==代码块==\n```", "==代码块=="],
    ["<mark>原样</mark>", "<mark>原样</mark>"],
  ]) {
    const value = {
      version: 2 as const,
      doc: parseRichTextMarkdown(source).toJSON(),
    };

    assert.ok(isSupportedRichText(value));
    assert.equal(richTextPlainText(value), plain);
    assert.equal(JSON.stringify(value).includes('"highlight"'), false);
  }
});

test("高亮恢复副本经 JSON 存储再读取仍保留选区格式", async () => {
  const { writeRichTextRecovery, readRichTextRecovery } =
    await import("../../src/lib/richTextRecovery");
  const richText = {
    version: 2 as const,
    doc: parseRichTextMarkdown("普通 ==重点==").toJSON(),
  };

  assert.ok(isSupportedRichText(richText));
  const source = {
    id: "highlight-recovery",
    type: "text",
    originalText: "普通 重点",
    richText: normalizeRichText(richText),
  };
  const values = new Map<string, string>();
  const storage = {
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    getItem: (key: string) => values.get(key) ?? null,
  };

  assert.equal(
    writeRichTextRecovery("highlight", source as any, storage),
    true,
  );
  assert.deepEqual(readRichTextRecovery("highlight", storage), source);
});

test("写入能力 3 支持高亮及旧文档，能力 1/2 不得覆盖任何含高亮文档", () => {
  const legacy = { type: "text", richText: richTextFromPlainText("旧文字") };
  const plainV2 = {
    type: "text",
    richText: { version: 2, doc: parseRichTextMarkdown("**粗体**").toJSON() },
  };
  const highlight = {
    type: "text",
    richText: { version: 2, doc: parseRichTextMarkdown("- ==重点==").toJSON() },
  };

  assert.equal(supportsRichTextWrite([legacy], 1), true);
  assert.equal(supportsRichTextWrite([legacy, plainV2], 2), true);
  assert.equal(supportsRichTextWrite([plainV2], 1), false);
  for (const capability of [undefined, 1, 2]) {
    assert.equal(supportsRichTextWrite([highlight], capability), false);
    assert.equal(
      supportsRichTextWrite([legacy, highlight, plainV2], capability),
      false,
    );
  }

  assert.equal(supportsRichTextWrite([legacy, plainV2, highlight], 3), true);
  assert.equal(
    supportsRichTextWrite(
      [{ type: "text", richText: { version: 99, doc: {} } }],
      3,
    ),
    false,
  );
});

test("高亮只接受无属性标记，拒绝自定义样式、重复标记及代码块格式", () => {
  const value = {
    version: 2,
    doc: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "重点", marks: [{ type: "highlight" }] },
          ],
        },
      ],
    },
  };

  assert.ok(isSupportedRichText(value));
  for (const marks of [
    [{ type: "highlight", attrs: { style: "background:red" } }],
    [{ type: "highlight" }, { type: "highlight" }],
  ]) {
    const invalid = structuredClone(value);

    invalid.doc.content[0].content[0].marks = marks;
    assert.equal(isSupportedRichText(invalid), false);
  }

  const code = structuredClone(value);

  code.doc.content[0].type = "codeBlock";
  assert.equal(isSupportedRichText(code), false);
});
