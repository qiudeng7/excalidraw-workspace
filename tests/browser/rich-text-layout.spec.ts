import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const editorRequire = createRequire(
  new URL("../../packages/excalidraw/package.json", import.meta.url),
);
let script: string;

test.beforeAll(async () => {
  const result = await editorRequire("esbuild").build({
    entryPoints: [
      fileURLToPath(
        new URL(
          "../../packages/excalidraw/lib/element/src/richTextLayout.ts",
          import.meta.url,
        ),
      ),
    ],
    tsconfig: fileURLToPath(
      new URL("../../packages/excalidraw/tsconfig.json", import.meta.url),
    ),
    bundle: true,
    write: false,
    format: "iife",
    globalName: "richLayout",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"test"', "import.meta.env": "{}" },
    loader: { ".woff2": "dataurl" },
  });

  script = result.outputFiles[0].text;
});

test("layout preserves v1 empty, consecutive and trailing hard-break lines", async ({
  page,
}) => {
  await page.addScriptTag({ content: script });
  const results = await page.evaluate(() => {
    const api = (window as any).richLayout;

    return ["", "a\n\nb", "\n\n", "a\n"].map((text) => ({
      text,
      layout: api.layoutRichText(
        {
          fontSize: 20,
          fontFamily: 2,
          lineHeight: 1.25,
          textAlign: "left",
          richText: {
            version: 1,
            doc: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: text
                    .split("\n")
                    .flatMap((value, index) => [
                      ...(index ? [{ type: "hardBreak" }] : []),
                      ...(value ? [{ type: "text", text: value }] : []),
                    ]),
                },
              ],
            },
          },
        },
        240,
      ),
    }));
  });

  for (const { text, layout } of results) {
    expect(layout.text).toBe(text);
    expect(layout.height).toBe(text.split("\n").length * 25);
  }
});

test("v2 shares heading metrics, list markers, code blank lines and decorations", async ({
  page,
}) => {
  await page.addScriptTag({ content: script });
  const result = await page.evaluate(() => {
    const api = (window as any).richLayout;
    const paragraph = (text: string) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    });

    return api.layoutRichText(
      {
        fontSize: 20,
        fontFamily: 2,
        lineHeight: 1.25,
        textAlign: "left",
        richText: {
          version: 2,
          doc: {
            type: "doc",
            content: [
              {
                type: "heading",
                attrs: { level: 1 },
                content: [{ type: "text", text: "Title" }],
              },
              {
                type: "orderedList",
                attrs: { order: 3 },
                content: [{ type: "listItem", content: [paragraph("Item")] }],
              },
              { type: "blockquote", content: [paragraph("Quote")] },
              {
                type: "codeBlock",
                content: [{ type: "text", text: "first\n\nlast\n" }],
              },
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "Link",
                    marks: [
                      { type: "link", attrs: { href: "https://example.com" } },
                      { type: "strike" },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      240,
    );
  });

  expect(result.runs.find((run: any) => run.text === "Title").fontSize).toBe(
    40,
  );
  expect(result.runs.find((run: any) => run.text === "Title").fontWeight).toBe(
    "700",
  );
  expect(result.runs.some((run: any) => run.text === "3.")).toBe(true);
  expect(result.text).toBe("Title\nItem\nQuote\nfirst\n\nlast\n\nLink");
  expect(result.decorations).toHaveLength(4);
  expect(result.height).toBe(237);
});
