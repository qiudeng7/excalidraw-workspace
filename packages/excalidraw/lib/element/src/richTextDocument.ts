/** Persisted schema. This module is browser independent and shared with the server. */
export type RichTextMark = "bold" | "italic" | "code";

export type RichTextInline =
  | { type: "text"; text: string; marks?: { type: RichTextMark }[] }
  | { type: "hardBreak" };

export type RichText = { version: number; doc: unknown };

export type RichTextV1 = {
  version: 1;
  doc: {
    type: "doc";
    content: [{ type: "paragraph"; content?: RichTextInline[] }];
  };
};
const MARKS: RichTextMark[] = ["bold", "italic", "code"];
const keys = (value: object, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const isRichTextV1 = (value: unknown): value is RichTextV1 => {
  if (!object(value) || !keys(value, ["version", "doc"]) || value.version !== 1)
    return false;
  const doc = value.doc;

  if (
    !object(doc) ||
    !keys(doc, ["type", "content"]) ||
    doc.type !== "doc" ||
    !Array.isArray(doc.content) ||
    doc.content.length !== 1
  )
    return false;
  const paragraph = doc.content[0];

  if (
    !object(paragraph) ||
    !keys(paragraph, ["type", "content"]) ||
    paragraph.type !== "paragraph"
  )
    return false;
  const content = paragraph.content ?? [];

  if (!Array.isArray(content) || content.length > 10000) return false;
  let length = 0;

  for (const node of content) {
    if (!object(node)) return false;
    if (node.type === "hardBreak") {
      if (!keys(node, ["type"])) return false;
      length++;
    } else if (node.type === "text") {
      if (
        !keys(node, ["type", "text", "marks"]) ||
        typeof node.text !== "string" ||
        !node.text ||
        /[\r\n\t]/.test(node.text)
      )
        return false;
      length += node.text.length;
      if (
        node.marks !== undefined &&
        (!Array.isArray(node.marks) ||
          node.marks.length > MARKS.length ||
          new Set(node.marks.map((mark: { type?: unknown }) => mark?.type))
            .size !== node.marks.length ||
          node.marks.some(
            (mark: unknown) =>
              !object(mark) ||
              !keys(mark, ["type"]) ||
              !MARKS.includes(mark.type as RichTextMark),
          ))
      )
        return false;
    } else return false;
    if (length > 1000000) return false;
  }

  return true;
};

export const richTextPlainText = (value: RichTextV1): string =>
  (value.doc.content[0].content ?? [])
    .map((node) => (node.type === "hardBreak" ? "\n" : node.text))
    .join("");

/** Literal import: existing Markdown punctuation is never interpreted. */
export const richTextFromPlainText = (text: string): RichTextV1 => {
  const content: RichTextInline[] = [];

  text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "        ")
    .split("\n")
    .forEach((line, index) => {
      if (index) content.push({ type: "hardBreak" });
      if (line) content.push({ type: "text", text: line });
    });

  return {
    version: 1,
    doc: {
      type: "doc",
      content: [{ type: "paragraph", ...(content.length ? { content } : {}) }],
    },
  };
};

export const normalizeRichText = (value: RichTextV1): RichTextV1 => {
  const content: RichTextInline[] = [];

  for (const node of value.doc.content[0].content ?? []) {
    if (node.type === "hardBreak") {
      content.push({ type: "hardBreak" });
      continue;
    }

    const marks = MARKS.filter((mark) =>
      node.marks?.some((item) => item.type === mark),
    ).map((type) => ({ type }));
    const previous = content[content.length - 1];

    if (
      previous?.type === "text" &&
      JSON.stringify(previous.marks ?? []) === JSON.stringify(marks)
    )
      previous.text += node.text;
    else
      content.push({
        type: "text",
        text: node.text,
        ...(marks.length ? { marks } : {}),
      });
  }

  return {
    version: 1,
    doc: {
      type: "doc",
      content: [{ type: "paragraph", ...(content.length ? { content } : {}) }],
    },
  };
};
