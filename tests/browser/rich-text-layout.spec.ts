import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
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

test("host synthesis restrictions do not suppress rich-text bold and italic faces", async ({
  page,
}) => {
  await page.addScriptTag({ content: script });
  const font = await readFile(
    new URL(
      "../../packages/excalidraw/fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2",
      import.meta.url,
    ),
  );
  const metrics = await page.evaluate(async (fontData) => {
    const face = new FontFace(
      "Nunito",
      `url(data:font/woff2;base64,${fontData})`,
      { weight: "400", style: "normal" },
    );

    document.fonts.add(await face.load());
    document.documentElement.style.fontSynthesis = "none";
    document.body.style.margin = "0";
    document.body.style.background = "white";
    const api = (window as any).richLayout;
    const element = {
      fontSize: 40,
      fontFamily: 6,
      lineHeight: 1.25,
      textAlign: "left",
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
                  text: "Synthetic bold",
                  marks: [{ type: "bold" }, { type: "italic" }],
                },
              ],
            },
          ],
        },
      },
    };
    const root = document.createElement("div");

    root.id = "synthesis-editor";
    root.innerHTML = "<p><strong><em>Synthetic bold</em></strong></p>";
    api.applyRichTextDocumentStyle(root, element, 400);
    root.style.color = "black";
    document.body.append(root);
    const layout = api.layoutRichText(element, 400);
    const run = layout.runs[0];
    const canvas = document.createElement("canvas");

    canvas.width = 400;
    canvas.height = 50;
    const context = canvas.getContext("2d")!;

    context.font = run.font;
    const canvasWidth = context.measureText(run.text).width;

    context.fillText(run.text, run.x, run.baseline);
    const pixels = context.getImageData(0, 0, 400, 50).data;
    let canvasInk = 0;

    for (let index = 3; index < pixels.length; index += 4)
      canvasInk += pixels[index] / 255;

    return {
      host: getComputedStyle(document.documentElement).fontSynthesis,
      editor: getComputedStyle(root).fontSynthesis,
      inline: getComputedStyle(root.querySelector("em")!).fontSynthesis,
      canvasWidth,
      measuredWidth: run.width,
      canvasInk,
    };
  }, font.toString("base64"));

  expect(metrics.host).toBe("none");
  expect(metrics.editor).toBe("weight style");
  expect(metrics.inline).toBe("weight style");
  expect(Math.abs(metrics.canvasWidth - metrics.measuredWidth)).toBeLessThan(1);
  const root = page.locator("#synthesis-editor");
  const enabled = await root.screenshot();

  await root.evaluate((node: HTMLElement) => {
    node.style.fontSynthesis = "none";
  });
  const disabled = await root.screenshot();
  const inks = await page.evaluate(
    async (images) => {
      return Promise.all(
        images.map(async (data) => {
          const image = new Image();

          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const canvas = document.createElement("canvas");

          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d")!;

          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(
            0,
            0,
            image.width,
            image.height,
          ).data;
          let ink = 0;

          for (let index = 0; index < pixels.length; index += 4)
            ink += (255 - pixels[index]) / 255;

          return ink;
        }),
      );
    },
    [enabled.toString("base64"), disabled.toString("base64")],
  );

  // A regular-only font must actually gain ink, rather than merely reporting font-weight:700.
  expect(inks[0]).toBeGreaterThan(inks[1] * 1.1);
  expect(
    Math.abs(inks[0] - metrics.canvasInk) / metrics.canvasInk,
  ).toBeLessThan(0.12);
});
