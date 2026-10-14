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

test("successfully persisted rich text over two million serialized characters remains readable", async () => {
  const { readRichTextRecovery, writeRichTextRecovery } =
    await import("../../src/lib/richTextRecovery");
  const text = "字".repeat(700000);
  const source = {
    type: "text",
    text,
    originalText: text,
    richText: richTextFromPlainText(text),
  } as any;
  const data = new Map<string, string>();
  const storage = {
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    getItem: (key: string) => data.get(key) ?? null,
  };

  assert.ok(JSON.stringify(source).length > 2000000);
  assert.equal(writeRichTextRecovery("large", source, storage), true);
  assert.deepEqual(readRichTextRecovery("large", storage), source);
});

test("failed rich-text writes report failure without deleting the previous persistent copy", async () => {
  const { readRichTextRecovery, writeRichTextRecovery } =
    await import("../../src/lib/richTextRecovery");
  const previous = {
    type: "text",
    richText: richTextFromPlainText("previous"),
  } as any;
  const next = { type: "text", richText: richTextFromPlainText("next") } as any;
  const stored = JSON.stringify(previous);

  for (const name of ["QuotaExceededError", "SecurityError"]) {
    const storage = {
      setItem: () => {
        throw new DOMException("storage unavailable", name);
      },
      getItem: () => stored,
    };

    assert.equal(writeRichTextRecovery("same-key", next, storage), false);
    assert.deepEqual(readRichTextRecovery("same-key", storage), previous);
  }

  assert.equal(writeRichTextRecovery("", next), false);
});

test("v2 validates block structure and projects nested lists, headings, quotes and code literally", async () => {
  const { isRichTextV2, isSupportedRichText } =
    await import("../../packages/excalidraw/lib/element/src/richTextDocument");
  const value = {
    version: 2 as const,
    doc: {
      type: "doc" as const,
      content: [
        {
          type: "heading" as const,
          attrs: { level: 2 },
          content: [{ type: "text" as const, text: "Title" }],
        },
        {
          type: "orderedList" as const,
          attrs: { order: 3 },
          content: [
            {
              type: "listItem" as const,
              content: [
                {
                  type: "paragraph" as const,
                  content: [
                    {
                      type: "text" as const,
                      text: "Item",
                      marks: [{ type: "strike" as const }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "blockquote" as const,
          content: [
            {
              type: "paragraph" as const,
              content: [
                {
                  type: "text" as const,
                  text: "Link",
                  marks: [
                    {
                      type: "link" as const,
                      attrs: { href: "https://example.test", title: null },
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "codeBlock" as const,
          attrs: { params: "js" },
          content: [{ type: "text" as const, text: "a\n\tb" }],
        },
      ],
    },
  };

  assert.ok(isRichTextV2(value));
  assert.ok(isSupportedRichText(value));
  assert.equal(richTextPlainText(value), "Title\nItem\nLink\na\n\tb");
  assert.deepEqual(normalizeRichText(value), value);
  assert.ok(isSupportedRichText(richTextFromPlainText("**unchanged**")));
  for (const block of [
    { type: "heading", attrs: { level: 7 } },
    {
      type: "orderedList",
      attrs: { order: 0 },
      content: value.doc.content[1].content,
    },
    { type: "bulletList", content: [{ type: "paragraph" }] },
    { type: "listItem", content: [{ type: "paragraph" }] },
    { type: "blockquote", content: [] },
    { type: "codeBlock", content: [{ type: "hardBreak" }] },
    {
      type: "codeBlock",
      content: [{ type: "text", text: "x", marks: [{ type: "bold" }] }],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "x",
          marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
        },
      ],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "x", marks: [{ type: ["bold"] }] }],
    },
    { type: "table" },
  ])
    assert.equal(
      isRichTextV2({ version: 2, doc: { type: "doc", content: [block] } }),
      false,
    );
  let deep: any = { type: "paragraph" };

  for (let i = 0; i < 34; i++) deep = { type: "blockquote", content: [deep] };
  assert.equal(
    isRichTextV2({ version: 2, doc: { type: "doc", content: [deep] } }),
    false,
  );
});

test("v1 capability cannot overwrite v2 room content even after stripping richText", async () => {
  const { createRoom, execute } =
    await import("../../shared/collaboration/room");
  const { canonical } = await import("../../shared/collaboration/merge");
  const owner = { userId: "owner", name: "Owner" };
  const richText = { ...richTextFromPlainText("safe"), version: 2 as const };
  const value = {
    id: "v2",
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
    richText,
  };
  const state = createRoom("rich", "owner", "Rich", "epoch", {
    elements: [],
    appState: {},
    files: {},
  });
  const operation = {
    protocolVersion: 1 as const,
    epoch: "epoch",
    clientId: "client",
    clientSeq: 1,
    opId: "v2",
    baseSeq: 0,
    elements: [value],
    textFormatVersion: 2 as const,
  };

  execute(state, owner, {
    type: "update",
    operation,
    digest: canonical(operation),
  });
  for (const elements of [
    [{ ...value, version: 2, richText: undefined }],
    [],
  ]) {
    const old = {
      ...operation,
      clientSeq: 2,
      opId: "old",
      baseSeq: state.seq,
      elements,
      textFormatVersion: 1 as const,
    };

    assert.throws(
      () =>
        execute(state, owner, {
          type: "update",
          operation: old,
          digest: canonical(old),
        }),
      /刷新/,
    );
  }

  assert.deepEqual(state.scene.elements[0].richText, richText);
  const { writeRichTextRecovery, readRichTextRecovery } =
    await import("../../src/lib/richTextRecovery");
  let raw = "";

  writeRichTextRecovery("key", value as any, {
    setItem: (_, next) => {
      raw = next;
    },
  });
  assert.deepEqual(
    readRichTextRecovery("key", { getItem: () => raw })?.richText,
    richText,
  );
});
