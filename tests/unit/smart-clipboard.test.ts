import assert from "node:assert/strict";
import test from "node:test";
import {
  createClipboardHTML,
  encodeNativeClipboard,
  getSemanticClipboardText,
  readNativeClipboardHTML,
  validateNativeClipboard,
  MAX_CLIPBOARD_HTML,
  beginClipboardOperation,
  writeSmartClipboard,
} from "../../packages/excalidraw/smartClipboard";
import type { ExcalidrawElement } from "../../packages/excalidraw/lib/element/src/types";

const text = {
  id: "label",
  type: "text",
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  angle: 0,
  version: 1,
  versionNonce: 1,
  groupIds: [],
  text: "soft\nwrap",
  originalText: "semantic <& 中文 👩‍💻>",
  fontSize: 20,
  fontFamily: 2,
  strokeColor: "#ff0000",
  textAlign: "left",
  isDeleted: false,
} as unknown as ExcalidrawElement;
const payload = (elements = [text]) => ({
  type: "excalidraw/clipboard",
  elements,
  files: {},
});
const encode = (value: unknown) => encodeNativeClipboard(JSON.stringify(value));

test("semantic text projects rich text and originalText, deduplicating labels", () => {
  const rich = {
    ...text,
    id: "rich",
    richText: {
      version: 2,
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Bold", marks: [{ type: "bold" }] },
            ],
          },
          { type: "paragraph", content: [{ type: "text", text: "next" }] },
        ],
      },
    },
  } as ExcalidrawElement;

  assert.equal(
    getSemanticClipboardText([text, text, rich]),
    "semantic <& 中文 👩‍💻>\n\nBold\nnext",
  );
});

test("HTML is visible editable text plus one embedded graphic; native unicode roundtrips inertly", () => {
  const encoded = encode(payload());
  const html = createClipboardHTML(
    encoded,
    [text, text],
    "data:image/png;base64,AAAA",
  );

  assert.equal((html.match(/semantic/g) ?? []).length, 1);
  assert.match(html, /semantic &lt;&amp; 中文 👩‍💻&gt;/);
  assert.equal((html.match(/<img/g) ?? []).length, 1);
  assert.deepEqual(readNativeClipboardHTML(html), payload());
  assert.doesNotMatch(html, /excalidraw\/clipboard/); // JSON is not visible.
});

test("HTML rejects CSS and HTML injection, unsafe links; preserves semantic marks/lists", () => {
  const rich = {
    ...text,
    strokeColor: "red;background:url(https://evil.test)",
    richText: {
      version: 2,
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: '<img onerror="bad()">',
                marks: [
                  { type: "bold" },
                  { type: "italic" },
                  {
                    type: "link",
                    attrs: { href: "https://safe.test/?a=1&b=2" },
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  } as ExcalidrawElement;
  const html = createClipboardHTML(encode(payload([rich])), [rich]);

  assert.match(html, /<em><strong>/);
  assert.match(html, /href="https:\/\/safe.test\/\?a=1&amp;b=2"/);
  assert.doesNotMatch(html, /background|<img|onerror="/);
  assert.match(html, /color:#000000/);
});

test("unknown/corrupt/oversize markers and invalid geometry/files are rejected", () => {
  assert.equal(
    readNativeClipboardHTML(
      '<div data-excalidraw-workspace="bad">visible</div>',
    ),
    null,
  );
  const unknown = Buffer.from(
    JSON.stringify({
      type: "excalidraw-workspace/clipboard",
      version: 2,
      data: payload(),
    }),
  ).toString("base64");

  assert.equal(
    readNativeClipboardHTML(
      `<div data-excalidraw-workspace="${unknown}">visible</div>`,
    ),
    null,
  );
  assert.equal(
    readNativeClipboardHTML(" ".repeat(MAX_CLIPBOARD_HTML + 1)),
    null,
  );
  assert.equal(
    validateNativeClipboard(
      payload([{ ...text, x: null } as unknown as ExcalidrawElement]),
    ),
    false,
  );
  assert.equal(
    validateNativeClipboard(
      payload([
        {
          ...text,
          id: "image",
          type: "image",
          fileId: "missing",
        } as unknown as ExcalidrawElement,
      ]),
    ),
    false,
  );
  assert.throws(
    () =>
      encode(
        payload([
          {
            ...text,
            originalText: "x".repeat(17 * 1024 * 1024),
          } as ExcalidrawElement,
        ]),
      ),
    /16 MiB/,
  );
});

test("restore-sensitive primitive fields cannot masquerade as valid native elements", () => {
  for (const invalid of [
    { link: 1 },
    { boundElementIds: {} },
    { font: {} },
    { fontSize: 0 },
    { lineHeight: 0 },
  ]) {
    const bad = payload([
      { ...text, ...invalid } as unknown as ExcalidrawElement,
    ]);

    assert.equal(validateNativeClipboard(bad), false);
    const marker = Buffer.from(
      JSON.stringify({
        type: "excalidraw-workspace/clipboard",
        version: 1,
        data: bad,
      }),
    ).toString("base64");

    assert.equal(
      readNativeClipboardHTML(
        `<div data-excalidraw-workspace="${marker}">readable fallback</div>`,
      ),
      null,
    );
  }
});

test("native transport retains sticky labels, frame membership, arrow bindings and referenced files", () => {
  const elements = [
    { ...text, id: "frame", type: "frame" },
    {
      ...text,
      id: "note",
      type: "stickynote",
      frameId: "frame",
      boundElements: [{ id: "label", type: "text" }],
    },
    { ...text, containerId: "note", frameId: "frame" },
    {
      ...text,
      id: "arrow",
      type: "arrow",
      points: [
        [0, 0],
        [100, 0],
      ],
      startBinding: { elementId: "note" },
    },
    { ...text, id: "image", type: "image", fileId: "asset" },
  ] as unknown as ExcalidrawElement[];
  const value = {
    ...payload(elements),
    files: {
      asset: {
        id: "asset",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA",
        created: 1,
      },
    },
  };

  assert.deepEqual(
    readNativeClipboardHTML(createClipboardHTML(encode(value), elements)),
    value,
  );
  assert.equal(
    getSemanticClipboardText(elements),
    getSemanticClipboardText([text]),
  );
});

test("writer starts one multi-format write synchronously, awaits rejection and invalidates older render", async () => {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldItem = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");
  const writes: Record<string, Promise<Blob>>[] = [];

  class Item {
    constructor(public data: Record<string, Promise<Blob>>) {
      writes.push(data);
    }
  }

  Object.defineProperty(globalThis, "ClipboardItem", {
    value: Item,
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        write: async (items: Item[]) => {
          await Promise.all(Object.values(items[0].data));
        },
      },
    },
    configurable: true,
  });
  try {
    let finish!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const first = writeSmartClipboard({
      plain: "one",
      html: pending,
      fallbackHTML: "",
      token: beginClipboardOperation(),
    });

    assert.equal(writes.length, 1);
    assert.deepEqual(Object.keys(writes[0]), ["text/html", "text/plain"]);
    const second = writeSmartClipboard({
      plain: "two",
      html: Promise.resolve("<p>two</p>"),
      fallbackHTML: "",
      token: beginClipboardOperation(),
    });

    finish("<p>one</p>");
    await assert.rejects(first, /取代/);
    assert.deepEqual(await second, { complete: true, current: true });
    Object.defineProperty(globalThis, "navigator", {
      value: {
        clipboard: { write: () => Promise.reject(new Error("denied")) },
      },
      configurable: true,
    });
    await assert.rejects(
      writeSmartClipboard({
        plain: "three",
        html: Promise.resolve("<p>three</p>"),
        fallbackHTML: "",
        token: beginClipboardOperation(),
      }),
      /denied/,
    );
    let attempts = 0;

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          write: async (items: Item[]) => {
            if (++attempts === 1)
              throw new TypeError("promised ClipboardItem unsupported");
            assert.ok(items[0].data["text/html"] instanceof Blob);
          },
        },
      },
    });
    assert.equal(
      (
        await writeSmartClipboard({
          plain: "retry",
          html: Promise.resolve("<b>retry</b>"),
          fallbackHTML: "",
          token: beginClipboardOperation(),
        })
      ).complete,
      true,
    );
    assert.equal(attempts, 2);
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: undefined,
    });
    let plainFallback = "";

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (value: string) => {
            plainFallback = value;
          },
        },
      },
    });
    assert.equal(
      (
        await writeSmartClipboard({
          plain: "readable",
          html: Promise.resolve("<b>readable</b>"),
          fallbackHTML: "<p>readable</p>",
          token: beginClipboardOperation(),
        })
      ).complete,
      false,
    );
    assert.equal(plainFallback, "readable");
    const eventData = new Map<string, string>();

    assert.equal(
      (
        await writeSmartClipboard({
          plain: "event",
          html: Promise.resolve("<b>event</b>"),
          fallbackHTML: "<p>event</p>",
          event: {
            clipboardData: {
              setData: (key: string, value: string) =>
                eventData.set(key, value),
            },
          } as unknown as ClipboardEvent,
          token: beginClipboardOperation(),
        })
      ).complete,
      false,
    );
    assert.deepEqual(Object.fromEntries(eventData), {
      "text/plain": "event",
      "text/html": "<p>event</p>",
    });
  } finally {
    if (oldNavigator)
      Object.defineProperty(globalThis, "navigator", oldNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (oldItem) Object.defineProperty(globalThis, "ClipboardItem", oldItem);
    else Reflect.deleteProperty(globalThis, "ClipboardItem");
  }
});
