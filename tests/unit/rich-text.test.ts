import assert from "node:assert/strict";
import test from "node:test";
import {
  isRichTextV1,
  normalizeRichText,
  richTextFromPlainText,
  richTextPlainText,
} from "../../packages/excalidraw/lib/element/src/richTextDocument";
import { richTextSchema } from "../../packages/excalidraw/wysiwyg/richTextEditor";
import { validateElement } from "../../shared/collaboration/merge";

test("rich text literal import and ProseMirror JSON retain newlines, emoji and Markdown punctuation", () => {
  for (const text of ["", "\n\n", "**literal**\n中文 👩‍💻\n", "مرحبا English"]) {
    const value = richTextFromPlainText(text);

    assert.ok(isRichTextV1(value));
    assert.equal(richTextPlainText(value), text);
    assert.deepEqual(
      normalizeRichText({
        version: 1,
        doc: richTextSchema.nodeFromJSON(value.doc).toJSON(),
      }),
      value,
    );
  }
});

test("rich text whitelist rejects unknown versions, nodes, marks, attributes and oversized content", () => {
  const value = richTextFromPlainText("safe");

  for (const candidate of [
    { ...value, version: 2 },
    { ...value, html: "<script>bad()</script>" },
    { ...value, doc: { type: "doc", content: [{ type: "heading" }] } },
    {
      ...value,
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "image", attrs: { src: "https://example.test" } },
            ],
          },
        ],
      },
    },
    {
      ...value,
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "x",
                marks: [{ type: "link", attrs: { href: "javascript:x" } }],
              },
            ],
          },
        ],
      },
    },
    richTextFromPlainText("x".repeat(1000001)),
  ])
    assert.equal(isRichTextV1(candidate), false);
});

test("normalization merges identical adjacent marks and preserves formatting", () => {
  const value = richTextFromPlainText("one");

  value.doc.content[0].content = [
    { type: "text", text: "a", marks: [{ type: "italic" }, { type: "bold" }] },
    { type: "text", text: "b", marks: [{ type: "bold" }, { type: "italic" }] },
    { type: "hardBreak" },
  ];
  const normalized = normalizeRichText(value);

  assert.deepEqual(normalized.doc.content[0].content, [
    { type: "text", text: "ab", marks: [{ type: "bold" }, { type: "italic" }] },
    { type: "hardBreak" },
  ]);
  assert.deepEqual(
    normalizeRichText({
      version: 1,
      doc: richTextSchema.nodeFromJSON(normalized.doc).toJSON(),
    }),
    normalized,
  );
});

test("server rejects inconsistent rich-text projections", () => {
  const element = {
    id: "text",
    type: "text",
    x: 0,
    y: 0,
    width: 10,
    height: 20,
    angle: 0,
    version: 1,
    versionNonce: 1,
    text: "safe",
    originalText: "safe",
    richText: richTextFromPlainText("safe"),
  };

  assert.doesNotThrow(() => validateElement(element));
  assert.throws(
    () => validateElement({ ...element, originalText: "tampered" }),
    /富文本/,
  );
  assert.throws(
    () => validateElement({ ...element, richText: { version: 2, doc: {} } }),
    /富文本/,
  );
});

test("legacy clients cannot rewrite or strip rich text after it enters a room", async () => {
  const { createRoom, execute } =
    await import("../../shared/collaboration/room");
  const { canonical } = await import("../../shared/collaboration/merge");
  const owner = { userId: "owner", name: "Owner" };
  const state = createRoom("rich", "owner", "Rich", "epoch", {
    elements: [],
    appState: {},
    files: {},
  });
  const value = {
    id: "text",
    type: "text",
    x: 0,
    y: 0,
    width: 10,
    height: 20,
    angle: 0,
    version: 1,
    versionNonce: 1,
    text: "safe",
    originalText: "safe",
    richText: richTextFromPlainText("safe"),
  };
  const operation = {
    protocolVersion: 1 as const,
    epoch: "epoch",
    clientId: "client",
    clientSeq: 1,
    opId: "rich-op",
    baseSeq: 0,
    elements: [value],
  };

  assert.throws(
    () =>
      execute(state, owner, {
        type: "update",
        operation,
        digest: canonical(operation),
      }),
    /刷新/,
  );
  const supported = { ...operation, textFormatVersion: 1 as const };

  execute(state, owner, {
    type: "update",
    operation: supported,
    digest: canonical(supported),
  });
  const stripped = { ...value, version: 2, richText: undefined };
  const legacy = {
    ...operation,
    clientSeq: 2,
    opId: "legacy-op",
    baseSeq: state.seq,
    elements: [stripped],
  };

  assert.throws(
    () =>
      execute(state, owner, {
        type: "update",
        operation: legacy,
        digest: canonical(legacy),
      }),
    /刷新/,
  );
  assert.deepEqual(state.scene.elements[0].richText, value.richText);
});

test("rich-text recovery stays discoverable after reload and isolates accounts, capabilities and browser tabs", async () => {
  const { richTextRecoveryStorageKey } =
    await import("../../src/lib/richTextRecovery");
  const options = {
    canvasId: "canvas",
    userId: "owner",
    token: "private-capability",
  };
  const key = await richTextRecoveryStorageKey(options, "tab-a");

  assert.equal(key, await richTextRecoveryStorageKey({ ...options }, "tab-a"));
  assert.ok(!key.includes(options.token));
  for (const [candidate, tab] of [
    [{ ...options, userId: "other" }, "tab-a"],
    [{ ...options, token: "other-capability" }, "tab-a"],
    [{ ...options, canvasId: "other" }, "tab-a"],
    [options, "tab-b"],
  ] as const)
    assert.notEqual(key, await richTextRecoveryStorageKey(candidate, tab));
});
