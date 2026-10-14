import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  parseRichTextMarkdown,
  richTextSchema,
  richTextKeymapCommands,
} from "../../packages/excalidraw/wysiwyg/richTextEditor";
import {
  isRichTextV2,
  normalizeRichText,
} from "../../packages/excalidraw/lib/element/src/richTextDocument";

const require = createRequire(
  new URL("../../packages/excalidraw/package.json", import.meta.url),
);
const { EditorState, TextSelection } = await import(
  require.resolve("prosemirror-state").replace(/index\.cjs$/, "index.js")
);

test("Markdown parses block structure, nested lists, links and inline formatting into valid v2", () => {
  const doc = parseRichTextMarkdown(
    '# 标题\n\n> 引用 **粗体**\n\n3. first\n4. second\n   - nested\n\n```ts\nconst x = 1;\n```\n\n[链接](https://example.com "标题") ~~删除~~ *斜体* `代码`',
  );

  assert.deepEqual(
    doc.content.content.map((node) => node.type.name),
    ["heading", "blockquote", "orderedList", "codeBlock", "paragraph"],
  );
  assert.equal(doc.child(0).attrs.level, 1);
  assert.equal(doc.child(2).attrs.order, 3);
  assert.equal(doc.child(2).child(1).child(1).type.name, "bulletList");
  assert.equal(doc.child(3).textContent, "const x = 1;");
  assert.equal(doc.child(3).attrs.params, "ts");
  assert.ok(isRichTextV2({ version: 2, doc: doc.toJSON() }));
});

test("Markdown keeps HTML, images and tables literal and rejects unsafe links", () => {
  for (const text of [
    "<b>literal</b>",
    "![image](https://example.com/a.png)",
    "| a | b |\n| - | - |",
    "[bad](javascript:alert(1))",
    "[bad](//example.com)",
  ]) {
    const doc = parseRichTextMarkdown(text);

    assert.equal(doc.textContent.replace(/\n/g, ""), text.replace(/\n/g, ""));
    assert.ok(isRichTextV2({ version: 2, doc: doc.toJSON() }));
  }
});

test("Markdown hard and soft line breaks retain separate visual lines", () => {
  const doc = parseRichTextMarkdown("first\nsecond  \nthird");

  assert.equal(doc.firstChild?.child(1).type.name, "hardBreak");
  assert.equal(doc.firstChild?.child(3).type.name, "hardBreak");
});

test("Enter splits list items, exits empty items and keeps code newlines", () => {
  let state = EditorState.create({
    schema: richTextSchema,
    doc: parseRichTextMarkdown("- one"),
  });

  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  const apply = (tr: Parameters<typeof state.apply>[0]) => {
    state = state.apply(tr);
  };

  assert.ok(richTextKeymapCommands.Enter(state, apply));
  assert.equal(state.doc.firstChild.childCount, 2);
  assert.ok(richTextKeymapCommands.Enter(state, apply));
  assert.equal(state.doc.lastChild.type.name, "paragraph");
  state = EditorState.create({
    schema: richTextSchema,
    doc: parseRichTextMarkdown("```\ncode\n```"),
  });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  assert.ok(richTextKeymapCommands.Enter(state, apply));
  assert.equal(state.doc.firstChild.textContent, "code\n");
  assert.ok(richTextKeymapCommands.ArrowDown(state, apply));
  assert.equal(state.doc.lastChild.type.name, "paragraph");
});

test("Enter after a typed fence starts a code block", () => {
  let state = EditorState.create({
    schema: richTextSchema,
    doc: richTextSchema.node("doc", null, [
      richTextSchema.node("paragraph", null, [richTextSchema.text("```ts")]),
    ]),
  });

  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  assert.ok(
    richTextKeymapCommands.Enter(state, (tr) => {
      state = state.apply(tr);
    }),
  );
  assert.equal(state.doc.firstChild.type.name, "codeBlock");
  assert.equal(state.doc.firstChild.attrs.params, "ts");
  assert.equal(state.doc.firstChild.textContent, "");
});

test("Markdown normalizes inline tabs but preserves code-block tabs", () => {
  const doc = parseRichTextMarkdown("inline\ttab\n\n```\ncode\ttab\n```");

  assert.equal(doc.firstChild?.textContent, "inline        tab");
  assert.equal(doc.lastChild?.textContent, "code\ttab");
  assert.ok(isRichTextV2({ version: 2, doc: doc.toJSON() }));
});

test("normalizing actual ProseMirror JSON makes every block and link attribute safe for history copies", () => {
  const doc = parseRichTextMarkdown(
    '## Heading\n\n3. [Link](https://example.test "Title")\n\n```ts\nconst value = 1;\n```',
  );
  const source = { version: 2 as const, doc: doc.toJSON() };

  // ProseMirror exposes null-prototype attribute objects directly in its JSON.
  assert.equal(Object.getPrototypeOf(source.doc.content[0].attrs), null);
  assert.ok(isRichTextV2(source));
  const normalized = normalizeRichText(source);
  const attributeNames: string[] = [];
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(inspect);

      return;
    }

    const record = value as Record<string, unknown>;

    assert.equal(Object.getPrototypeOf(record), Object.prototype);
    for (const key of Object.keys(record)) {
      // Excalidraw history's deepCopyElement traverses with this own-property
      // method: a null-prototype attrs object throws before it can be copied.
      assert.equal(record.hasOwnProperty(key), true);
      if (key === "attrs")
        attributeNames.push(...Object.keys(record[key] as object));
      inspect(record[key]);
    }
  };

  inspect(normalized);
  assert.deepEqual(attributeNames.sort(), [
    "href",
    "level",
    "order",
    "params",
    "title",
  ]);
  const copied = structuredClone(normalized);

  assert.deepEqual(copied, normalized);
  assert.notEqual(copied.doc.content[0].attrs, normalized.doc.content[0].attrs);
  assert.ok(isRichTextV2(copied));
  assert.equal(Object.getPrototypeOf(source.doc.content[0].attrs), null);
});
