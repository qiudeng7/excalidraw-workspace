import { getFontFamilyString } from "@excalidraw/common";
import { isRichTextV1 } from "./richTextDocument";
import type { RichTextMark, RichTextV1 } from "./richTextDocument";
import type { ExcalidrawTextElement } from "./types";

export const RICH_TEXT_CODE_FONT =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export const richTextMarkStyle = (marks: readonly RichTextMark[]) => ({
  fontWeight: marks.includes("bold") ? "700" : "400",
  fontStyle: marks.includes("italic") ? "italic" : "normal",
  ...(marks.includes("code") ? { fontFamily: RICH_TEXT_CODE_FONT } : {}),
});

export const richTextBlockStyle = (
  element: Pick<
    ExcalidrawTextElement,
    "fontSize" | "fontFamily" | "lineHeight" | "textAlign"
  >,
  width: number,
) => ({
  margin: "0",
  padding: "0",
  border: "0",
  outline: "none",
  fontFamily: getFontFamilyString(element),
  fontSize: `${element.fontSize}px`,
  fontWeight: "400",
  fontStyle: "normal",
  lineHeight: `${element.fontSize * element.lineHeight}px`,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  wordBreak: "normal",
  textAlign: element.textAlign,
  tabSize: "8",
  fontKerning: "normal",
  width: Number.isFinite(width) ? `${Math.max(width, 1)}px` : "max-content",
});

export interface RichTextRun {
  text: string;
  x: number;
  width: number;
  baseline: number;
  font: string;
  direction: "rtl" | "ltr";
  marks: RichTextMark[];
}

export interface RichTextLayout {
  runs: RichTextRun[];
  text: string;
  width: number;
  height: number;
}
const cache = new Map<string, RichTextLayout>();
let observedFonts: FontFaceSet | undefined;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Native line breaking and shaping are measured once, then consumed by Canvas and SVG.
 * Text is drawn in contiguous styled runs, never glyph by glyph. */
export const layoutRichText = (
  element: Pick<
    ExcalidrawTextElement,
    "richText" | "fontSize" | "fontFamily" | "lineHeight" | "textAlign"
  >,
  width = Infinity,
): RichTextLayout | null => {
  if (!isRichTextV1(element.richText) || typeof document === "undefined")
    return null;
  if (document.fonts && observedFonts !== document.fonts) {
    observedFonts = document.fonts;
    document.fonts.addEventListener("loadingdone", () => cache.clear());
  }

  const key = JSON.stringify([
    element.richText,
    element.fontSize,
    element.fontFamily,
    element.lineHeight,
    element.textAlign,
    width,
    document.fonts?.status,
  ]);
  const hit = cache.get(key);

  if (hit) return hit;
  const block = document.createElement("div");

  Object.assign(block.style, richTextBlockStyle(element, width), {
    position: "fixed",
    left: "-100000px",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
  });
  block.dir = "auto";
  const nodes: { node: Text; marks: RichTextMark[] }[] = [];

  for (const item of (element.richText as RichTextV1).doc.content[0].content ??
    []) {
    if (item.type === "hardBreak") {
      block.append(document.createElement("br"));
      continue;
    }

    const span = document.createElement("span");
    const marks = item.marks?.map((mark) => mark.type) ?? [];

    Object.assign(span.style, richTextMarkStyle(marks));
    const node = document.createTextNode(item.text);

    span.append(node);
    block.append(span);
    nodes.push({ node, marks });
  }

  // A zero-height inline box reveals the last line's native baseline, including trailing blank lines.
  const marker = document.createElement("span");

  Object.assign(marker.style, {
    display: "inline-block",
    width: "0",
    height: "0",
    padding: "0",
    margin: "0",
  });
  block.append(marker);
  document.body.append(block);
  try {
    const bounds = block.getBoundingClientRect();
    const direction =
      getComputedStyle(block).direction === "rtl" ? "rtl" : "ltr";
    const lineHeight = element.fontSize * element.lineHeight;
    const lineCount = Math.max(1, Math.round(bounds.height / lineHeight));
    const firstBaseline =
      marker.getBoundingClientRect().top -
      bounds.top -
      (lineCount - 1) * lineHeight;
    const lines: string[] = Array.from({ length: lineCount }, () => "");
    const runs: RichTextRun[] = [];
    const range = document.createRange();

    for (const { node, marks } of nodes) {
      let current: RichTextRun | undefined;
      let currentLine = -1;

      for (const { segment, index } of segmenter.segment(node.data)) {
        range.setStart(node, index);
        range.setEnd(node, index + segment.length);
        const rect = range.getBoundingClientRect();
        const line = Math.max(
          0,
          Math.min(
            lineCount - 1,
            Math.round((rect.top - bounds.top) / lineHeight),
          ),
        );

        lines[line] += segment;
        if (!current || currentLine !== line) {
          current = {
            text: segment,
            x: rect.left - bounds.left,
            width: rect.width,
            baseline: firstBaseline + line * lineHeight,
            font: `${marks.includes("italic") ? "italic " : ""}${marks.includes("bold") ? "700 " : ""}${element.fontSize}px ${marks.includes("code") ? RICH_TEXT_CODE_FONT : getFontFamilyString(element)}`,
            direction,
            marks,
          };
          runs.push(current);
          currentLine = line;
        } else {
          const left = Math.min(current.x, rect.left - bounds.left);

          current.width =
            Math.max(current.x + current.width, rect.right - bounds.left) -
            left;
          current.x = left;
          current.text += segment;
        }
      }
    }

    const result = {
      runs,
      text: lines.join("\n"),
      width: bounds.width,
      height: lineCount * lineHeight,
    };

    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, result);

    return result;
  } finally {
    block.remove();
  }
};
