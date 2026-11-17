import {
  isSupportedRichText,
  richTextPlainText,
} from "@excalidraw/excalidraw/rich-text";

export interface SearchCanvasRef {
  id: string;
  name: string;
  workspaceId: string;
  /** Display-only ancestor names; never included in matching. */
  folderPath?: string;
}

export type CanvasSearchMatchKind = "text" | "frame";

export interface CanvasSearchMatch {
  kind: CanvasSearchMatchKind;
  elementId: string;
  snippet: string;
  /** UTF-16 offset into snippet, inclusive. */
  matchStart: number;
  /** UTF-16 offset into snippet, exclusive. */
  matchEnd: number;
}

export interface CanvasSearchGroup {
  canvas: SearchCanvasRef;
  titleMatched: boolean;
  matches: CanvasSearchMatch[];
}

export interface SearchSkippedCanvas {
  canvasId: string;
  code: string;
}

export interface SearchPage {
  groups: CanvasSearchGroup[];
  nextCursor: string | null;
  catalogRevision: number;
  validatedCurrentCanvasId?: string;
  skipped: SearchSkippedCanvas[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const literalPattern = (query: string) =>
  new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");

const snippetFor = (value: string, start: number, length: number) => {
  let snippetStart = Math.max(0, start - 48);
  let snippetEnd = Math.min(value.length, start + length + 48);

  if (
    snippetStart > 0 &&
    value.charCodeAt(snippetStart) >= 0xdc00 &&
    value.charCodeAt(snippetStart) <= 0xdfff
  )
    snippetStart--;
  if (
    snippetEnd < value.length &&
    value.charCodeAt(snippetEnd - 1) >= 0xd800 &&
    value.charCodeAt(snippetEnd - 1) <= 0xdbff
  )
    snippetEnd++;

  return {
    snippet: value.slice(snippetStart, snippetEnd),
    matchStart: start - snippetStart,
    matchEnd: start - snippetStart + length,
  };
};

const textFor = (element: Record<string, unknown>) => {
  if (isSupportedRichText(element.richText))
    return richTextPlainText(element.richText);

  return typeof element.text === "string" ? element.text : "";
};

/** Match one canvas title and its live scene without mutating the supplied data. */
export const searchCanvas = (
  canvas: SearchCanvasRef,
  elements: readonly unknown[],
  query: string,
): CanvasSearchGroup | undefined => {
  const normalizedQuery = query.trim();

  if (!normalizedQuery) return undefined;

  const pattern = literalPattern(normalizedQuery);
  const titleMatched = pattern.test(canvas.name);
  const matches: CanvasSearchMatch[] = [];

  for (const item of elements) {
    if (!object(item) || item.isDeleted === true || typeof item.id !== "string")
      continue;
    if (item.type !== "text" && item.type !== "frame") continue;

    const kind = item.type;
    const text = kind === "frame" ? item.name : textFor(item);

    if (typeof text !== "string") continue;
    const match = pattern.exec(text);

    if (!match) continue;
    matches.push({
      kind,
      elementId: item.id,
      ...snippetFor(text, match.index, match[0].length),
    });
  }

  if (!titleMatched && !matches.length) return undefined;

  return { canvas, titleMatched, matches };
};
