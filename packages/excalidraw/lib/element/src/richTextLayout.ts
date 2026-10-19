import { getFontFamilyString } from "@excalidraw/common";
import { isSupportedRichText } from "./richTextDocument";
import type { RichTextV2Mark } from "./richTextDocument";
import type { ExcalidrawTextElement } from "./types";

type RichTextMark = RichTextV2Mark["type"];

export const RICH_TEXT_HIGHLIGHT_COLOR = "#ffd43b";

export const RICH_TEXT_HIGHLIGHT_OPACITY = 0.4;

export const RICH_TEXT_CODE_FONT =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export const richTextMarkStyle = (marks: readonly RichTextMark[]) => ({
  fontWeight: marks.includes("bold") ? "700" : "400",
  fontStyle: marks.includes("italic") ? "italic" : "normal",
  ...(marks.includes("code") ? { fontFamily: RICH_TEXT_CODE_FONT } : {}),
});

type TextStyle = Pick<
  ExcalidrawTextElement,
  "fontSize" | "fontFamily" | "lineHeight" | "textAlign"
>;

export const richTextBlockStyle = (element: TextStyle, width: number) => ({
  margin: "0",
  padding: "0",
  border: "0",
  outline: "none",
  fontFamily: getFontFamilyString(element),
  fontSize: `${element.fontSize}px`,
  fontWeight: "400",
  fontStyle: "normal",
  // Canvas synthesizes missing bold/italic faces even when the host disables CSS synthesis.
  fontSynthesis: "weight style",
  lineHeight: String(element.lineHeight),
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  wordBreak: "normal",
  textAlign: element.textAlign,
  tabSize: "8",
  fontKerning: "normal",
  width: Number.isFinite(width) ? `${Math.max(width, 1)}px` : "max-content",
});

/** The editor and measurement DOM intentionally use the exact same scoped rules. */
export const applyRichTextDocumentStyle = (
  root: HTMLElement,
  element: TextStyle,
  width: number,
) => {
  const doc = root.ownerDocument;

  if (!doc.getElementById("excalidraw-rich-text-style")) {
    const style = doc.createElement("style");

    style.id = "excalidraw-rich-text-style";
    const scope = "[data-excalidraw-rich-text]";

    style.textContent = `
${scope}, ${scope} * { box-sizing: border-box; }
${scope} :is(p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,li,pre) { margin:0; border:0; padding:0; font-family:inherit; line-height:inherit; }
${scope} p { min-height:1lh; }
${scope} :is(h1,h2,h3,h4,h5,h6) { font-weight:700; }
${scope} h1 { font-size:2em; } ${scope} h2 { font-size:1.5em; } ${scope} h3 { font-size:1.25em; }
${scope} h4 { font-size:1.125em; } ${scope} h5 { font-size:1em; } ${scope} h6 { font-size:.875em; }
${scope} :is(ul,ol) { padding-left:1.6em; list-style:none; counter-reset:rich-item; }
${scope} li { position:relative; counter-increment:rich-item; }
${scope} li::before { position:absolute; right:calc(100% + .4em); content:"•"; white-space:pre; }
${scope} ol > li::before { content:counter(rich-item) "."; }
${scope} ol[start] { counter-reset:rich-item var(--rich-list-start, 0); }
${scope} blockquote { border-left:.15em solid currentColor; padding-left:.6em; }
${scope} pre { font-family:${RICH_TEXT_CODE_FONT}; padding:.3em .4em; background:color-mix(in srgb, currentColor 12%, transparent); white-space:pre-wrap; }
${scope} code { font-family:${RICH_TEXT_CODE_FONT}; font-size:1em; }
${scope} a { color:inherit; text-decoration:underline; cursor:text; }
${scope} :is(s,del) { text-decoration:line-through; }
${scope} mark { color:inherit; background:color-mix(in srgb, ${RICH_TEXT_HIGHLIGHT_COLOR} ${RICH_TEXT_HIGHLIGHT_OPACITY * 100}%, transparent); }
${scope} strong { font-weight:700; } ${scope} em { font-style:italic; }
${scope} [data-rich-marker] { position:absolute; right:calc(100% + .4em); white-space:pre; }
${scope}[data-rich-measure] li::before { content:none; }
`;
    doc.head.append(style);
  }

  root.setAttribute("data-excalidraw-rich-text", "");
  Object.assign(root.style, richTextBlockStyle(element, width));
  // CSS counters cannot read the HTML start attribute consistently across engines.
  root
    .querySelectorAll("ol")
    .forEach((list) =>
      list.style.setProperty(
        "--rich-list-start",
        String((Number(list.getAttribute("start")) || 1) - 1),
      ),
    );
};

export interface RichTextRun {
  text: string;
  x: number;
  width: number;
  baseline: number;
  font: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  fontStyle: string;
  direction: "rtl" | "ltr";
  marks: RichTextMark[];
}

export interface RichTextDecoration {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  fill?: string;
}

export interface RichTextLayout {
  runs: RichTextRun[];
  decorations: RichTextDecoration[];
  text: string;
  width: number;
  height: number;
}
const cache = new Map<string, RichTextLayout>();
let observedFonts: FontFaceSet | undefined;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type LayoutNode = {
  type: string;
  text?: string;
  attrs?: { level?: number; order?: number };
  marks?: { type: RichTextMark }[];
  content?: LayoutNode[];
};

/** Native shaping and wrapping are measured once for Canvas, SVG and PNG. */
export const layoutRichText = (
  element: TextStyle & Pick<ExcalidrawTextElement, "richText">,
  width = Infinity,
): RichTextLayout | null => {
  if (!isSupportedRichText(element.richText) || typeof document === "undefined")
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

  block.setAttribute("data-rich-measure", "");
  const leaves: HTMLElement[] = [];
  const nodes: { node: Text; marks: RichTextMark[]; leaf: HTMLElement }[] = [];
  const render = (
    item: LayoutNode,
    parent: HTMLElement,
    leaf?: HTMLElement,
  ) => {
    if (item.type === "hardBreak") {
      parent.append(document.createElement("br"));

      return;
    }

    if (item.type === "text") {
      let span: HTMLElement = document.createElement("span");

      parent.append(span);
      for (const mark of item.marks ?? []) {
        const tag = (
          {
            bold: "strong",
            italic: "em",
            code: "code",
            strike: "s",
            highlight: "mark",
            link: "a",
          } as Record<string, string>
        )[mark.type];
        const child = document.createElement(tag || "span");

        span.append(child);
        span = child;
      }

      const node = document.createTextNode(item.text ?? "");

      span.append(node);
      nodes.push({
        node,
        marks: item.marks?.map((m) => m.type) ?? [],
        leaf: leaf!,
      });

      return;
    }

    const tag =
      item.type === "heading"
        ? `h${item.attrs?.level ?? 1}`
        : (
            {
              paragraph: "p",
              blockquote: "blockquote",
              bulletList: "ul",
              orderedList: "ol",
              listItem: "li",
              codeBlock: "pre",
            } as Record<string, string>
          )[item.type] || "div";
    const container = document.createElement(tag);

    parent.append(container);
    if (item.type === "orderedList")
      container.setAttribute("start", String(item.attrs?.order ?? 1));
    const isLeaf = ["paragraph", "heading", "codeBlock"].includes(item.type);

    if (isLeaf) leaves.push(container);
    let target = container;

    if (item.type === "codeBlock") {
      target = document.createElement("code");
      container.append(target);
    }

    for (const child of item.content ?? [])
      render(child, target, isLeaf ? container : leaf);
  };

  for (const item of (element.richText.doc as LayoutNode).content ?? [])
    render(item, block);
  applyRichTextDocumentStyle(block, element, width);
  Object.assign(block.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
  });
  block.dir = "auto";
  const markers = new Map<HTMLElement, HTMLElement>();

  for (const leaf of leaves) {
    const marker = document.createElement("span");

    Object.assign(marker.style, {
      display: "inline-block",
      width: "0",
      height: "0",
      padding: "0",
      margin: "0",
    });
    // ProseMirror adds a trailing break to keep an empty final line editable.
    // Match it here; a zero-sized baseline marker alone does not create that line.
    const last = leaf.lastChild;

    if (
      last instanceof HTMLBRElement ||
      (leaf.tagName === "PRE" && leaf.textContent?.endsWith("\n"))
    ) {
      leaf.append(document.createElement("br"));
    }

    leaf.append(marker);
    markers.set(leaf, marker);
  }

  for (const li of block.querySelectorAll("li")) {
    const marker = document.createElement("span");

    marker.setAttribute("data-rich-marker", "");
    const list = li.parentElement!;
    const index =
      Array.from(list.children).indexOf(li) +
      (Number(list.getAttribute("start")) || 1);
    const node = document.createTextNode(
      list.tagName === "OL" ? `${index}.` : "•",
    );

    marker.append(node);
    li.prepend(marker);
    const leaf = li.querySelector("p,h1,h2,h3,h4,h5,h6,pre") as HTMLElement;

    if (leaf) nodes.push({ node, marks: [], leaf });
  }

  document.body.append(block);
  try {
    const bounds = block.getBoundingClientRect();
    const runs: RichTextRun[] = [];
    const decorations: RichTextDecoration[] = [];
    const highlights: RichTextDecoration[] = [];
    const lines = new Map<string, string>();
    const leafIndices = new Map(leaves.map((leaf, index) => [leaf, index]));
    const range = document.createRange();

    for (const { node, marks, leaf } of nodes) {
      if (marks.includes("highlight")) {
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          highlights.push({
            x: rect.left - bounds.left,
            y: rect.top - bounds.top,
            width: rect.width,
            height: rect.height,
            fill: RICH_TEXT_HIGHLIGHT_COLOR,
            opacity: RICH_TEXT_HIGHLIGHT_OPACITY,
          });
        }
      }

      const style = getComputedStyle(node.parentElement!);
      const leafStyle = getComputedStyle(leaf);
      const lineHeight = parseFloat(leafStyle.lineHeight);
      const leafBounds = leaf.getBoundingClientRect();
      const paddingTop = parseFloat(leafStyle.paddingTop) || 0;
      const paddingBottom = parseFloat(leafStyle.paddingBottom) || 0;
      const lineCount = Math.max(
        1,
        Math.round(
          (leafBounds.height - paddingTop - paddingBottom) / lineHeight,
        ),
      );
      const firstBaseline =
        markers.get(leaf)!.getBoundingClientRect().top -
        bounds.top -
        (lineCount - 1) * lineHeight;
      let current: RichTextRun | undefined;
      let previousLine = -1;

      for (const { segment, index } of segmenter.segment(node.data)) {
        range.setStart(node, index);
        range.setEnd(node, index + segment.length);
        const rect = range.getBoundingClientRect();

        if (segment === "\n") continue;
        const line = Math.max(
          0,
          Math.min(
            lineCount - 1,
            Math.round((rect.top - leafBounds.top - paddingTop) / lineHeight),
          ),
        );
        const baseline = firstBaseline + line * lineHeight;

        if (!node.parentElement!.hasAttribute("data-rich-marker")) {
          const lineKey = `${leafIndices.get(leaf)}:${line}`;

          lines.set(lineKey, (lines.get(lineKey) ?? "") + segment);
        }

        if (!current || previousLine !== line) {
          current = {
            text: segment,
            x: rect.left - bounds.left,
            width: rect.width,
            baseline,
            font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
            fontFamily: style.fontFamily,
            fontSize: parseFloat(style.fontSize),
            fontWeight: style.fontWeight,
            fontStyle: style.fontStyle,
            direction: style.direction === "rtl" ? "rtl" : "ltr",
            marks,
          };
          runs.push(current);
          previousLine = line;
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

    const plainLines: string[] = [];

    for (const leaf of leaves) {
      const style = getComputedStyle(leaf);
      const lineHeight = parseFloat(style.lineHeight);
      const height =
        leaf.getBoundingClientRect().height -
        (parseFloat(style.paddingTop) || 0) -
        (parseFloat(style.paddingBottom) || 0);
      const count = Math.max(1, Math.round(height / lineHeight));

      for (let line = 0; line < count; line++) {
        plainLines.push(lines.get(`${leafIndices.get(leaf)}:${line}`) ?? "");
      }
    }

    for (const decoration of block.querySelectorAll("pre,blockquote")) {
      const rect = decoration.getBoundingClientRect();
      const quote = decoration.tagName === "BLOCKQUOTE";

      decorations.push({
        x: rect.left - bounds.left,
        y: rect.top - bounds.top,
        width: quote
          ? parseFloat(getComputedStyle(decoration).borderLeftWidth)
          : rect.width,
        height: rect.height,
        opacity: quote ? 1 : 0.12,
      });
    }

    // Block backgrounds first, then inline highlights, then text decorations.
    decorations.push(...highlights);
    for (const run of runs) {
      if (run.marks.includes("strike"))
        decorations.push({
          x: run.x,
          y: run.baseline - run.fontSize * 0.3,
          width: run.width,
          height: Math.max(1, run.fontSize / 16),
          opacity: 1,
        });
      if (run.marks.includes("link"))
        decorations.push({
          x: run.x,
          y: run.baseline + run.fontSize * 0.1,
          width: run.width,
          height: Math.max(1, run.fontSize / 16),
          opacity: 1,
        });
    }

    const result = {
      runs,
      decorations,
      text: plainLines.join("\n"),
      width: bounds.width,
      height: bounds.height,
    };

    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, result);

    return result;
  } finally {
    block.remove();
  }
};
