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

export const richTextPlainText = (value: SupportedRichText): string => {
  const project = (node: RichTextBlock | RichTextV2Inline): string => {
    if (node.type === "text") return node.text;
    if (node.type === "hardBreak") return "\n";

    return (node.content ?? [])
      .map(project)
      .join(
        ["paragraph", "heading", "codeBlock"].includes(node.type) ? "" : "\n",
      );
  };

  return value.doc.content.map(project).join("\n");
};

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

export const normalizeRichText = <T extends SupportedRichText>(value: T): T => {
  if (value.version === 2) return normalizeRichTextV2(value) as T;
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
  } as T;
};

export type RichTextV2Mark =
  | { type: RichTextMark | "strike" | "highlight" }
  | { type: "link"; attrs: { href: string; title?: string | null } };

export type RichTextV2Inline =
  | { type: "text"; text: string; marks?: RichTextV2Mark[] }
  | { type: "hardBreak" };

export type RichTextBlock =
  | { type: "paragraph"; content?: RichTextV2Inline[] }
  | { type: "heading"; attrs: { level: number }; content?: RichTextV2Inline[] }
  | {
      type: "codeBlock";
      attrs?: { params?: string | null };
      content?: RichTextV2Inline[];
    }
  | { type: "blockquote" | "bulletList" | "listItem"; content: RichTextBlock[] }
  | {
      type: "orderedList";
      attrs?: { order?: number };
      content: RichTextBlock[];
    };

export type RichTextV2 = {
  version: 2;
  doc: { type: "doc"; content: RichTextBlock[] };
};

export type SupportedRichText = RichTextV1 | RichTextV2;
const V2_MARKS = ["bold", "italic", "code", "strike", "link", "highlight"];

export const isSafeRichTextLink = (href: string): boolean =>
  href.length <= 10000 &&
  !/[\u0000-\u0020\u007f]/.test(href) &&
  /^(https?:\/\/|mailto:|tel:|\/|#|\.\.?\/)/i.test(href) &&
  !href.startsWith("//");

/** Same limits and whitelist apply at import, recovery, API and collaboration boundaries. */
export const isRichTextV2 = (value: unknown): value is RichTextV2 => {
  if (!object(value) || !keys(value, ["version", "doc"]) || value.version !== 2)
    return false;
  const doc = value.doc;

  if (
    !object(doc) ||
    !keys(doc, ["type", "content"]) ||
    doc.type !== "doc" ||
    !Array.isArray(doc.content) ||
    !doc.content.length
  )
    return false;
  let count = 0;
  let length = 0;
  const visit = (node: unknown, depth: number, parent: string): boolean => {
    if (
      ++count > 10000 ||
      depth > 32 ||
      !object(node) ||
      typeof node.type !== "string"
    )
      return false;
    const type = node.type;
    const inline = ["paragraph", "heading", "codeBlock"].includes(parent);

    if (type === "text") {
      if (
        !inline ||
        !keys(node, ["type", "text", "marks"]) ||
        typeof node.text !== "string" ||
        !node.text ||
        (parent !== "codeBlock" && /[\r\n\t]/.test(node.text))
      )
        return false;
      length += node.text.length;
      if (length > 1000000) return false;
      if (node.marks === undefined) return true;
      if (
        !Array.isArray(node.marks) ||
        node.marks.length > V2_MARKS.length ||
        (parent === "codeBlock" && node.marks.length)
      )
        return false;
      const seen = new Set();

      return node.marks.every((mark) => {
        if (
          !object(mark) ||
          typeof mark.type !== "string" ||
          !V2_MARKS.includes(mark.type) ||
          seen.has(mark.type)
        )
          return false;
        seen.add(mark.type);
        if (mark.type !== "link") return keys(mark, ["type"]);
        const attrs = mark.attrs;

        return (
          keys(mark, ["type", "attrs"]) &&
          object(attrs) &&
          keys(attrs, ["href", "title"]) &&
          typeof attrs.href === "string" &&
          isSafeRichTextLink(attrs.href) &&
          (attrs.title === undefined ||
            attrs.title === null ||
            (typeof attrs.title === "string" && attrs.title.length <= 10000))
        );
      });
    }

    if (type === "hardBreak")
      return (
        inline &&
        parent !== "codeBlock" &&
        keys(node, ["type"]) &&
        ++length <= 1000000
      );
    if (inline || !keys(node, ["type", "content", "attrs"])) return false;
    if (
      ["bulletList", "orderedList"].includes(parent)
        ? type !== "listItem"
        : type === "listItem"
    )
      return false;
    const attrs = node.attrs;

    if (type === "heading") {
      if (
        !object(attrs) ||
        !keys(attrs, ["level"]) ||
        !Number.isInteger(attrs.level) ||
        (attrs.level as number) < 1 ||
        (attrs.level as number) > 6
      )
        return false;
    } else if (type === "orderedList") {
      if (
        attrs !== undefined &&
        (!object(attrs) ||
          !keys(attrs, ["order"]) ||
          (attrs.order !== undefined &&
            (!Number.isSafeInteger(attrs.order) ||
              (attrs.order as number) < 1)))
      )
        return false;
    } else if (type === "codeBlock") {
      if (
        attrs !== undefined &&
        (!object(attrs) ||
          !keys(attrs, ["params"]) ||
          (attrs.params !== undefined &&
            attrs.params !== null &&
            (typeof attrs.params !== "string" || attrs.params.length > 10000)))
      )
        return false;
    } else if (
      !["paragraph", "blockquote", "bulletList", "listItem"].includes(type) ||
      attrs !== undefined
    )
      return false;
    const content = node.content ?? [];

    if (!Array.isArray(content)) return false;
    if (
      !["paragraph", "heading", "codeBlock"].includes(type) &&
      !content.length
    )
      return false;
    if (type === "listItem" && content[0]?.type !== "paragraph") return false;

    return content.every((child) => visit(child, depth + 1, type));
  };

  return doc.content.every((node) => visit(node, 0, "doc"));
};

export const isSupportedRichText = (
  value: unknown,
): value is SupportedRichText => isRichTextV1(value) || isRichTextV2(value);

function normalizeRichTextV2(value: RichTextV2): RichTextV2 {
  const normalize = (
    node: RichTextBlock | RichTextV2Inline,
  ): RichTextBlock | RichTextV2Inline => {
    if (node.type === "hardBreak") return { type: "hardBreak" };
    if (node.type === "text") {
      const marks = (node.marks ?? [])
        .map((mark) =>
          mark.type === "link"
            ? { ...mark, attrs: { ...mark.attrs } }
            : { ...mark },
        )
        .sort((a, b) => V2_MARKS.indexOf(a.type) - V2_MARKS.indexOf(b.type));

      return {
        type: "text",
        text: node.text,
        ...(marks.length ? { marks } : {}),
      };
    }

    const content: (RichTextBlock | RichTextV2Inline)[] = [];

    for (const child of node.content ?? []) {
      const next = normalize(child);
      const previous = content[content.length - 1];

      if (
        next.type === "text" &&
        previous?.type === "text" &&
        JSON.stringify(next.marks ?? []) ===
          JSON.stringify(previous.marks ?? [])
      )
        previous.text += next.text;
      else content.push(next);
    }

    return {
      ...node,
      ...("attrs" in node && node.attrs ? { attrs: { ...node.attrs } } : {}),
      ...(content.length ? { content } : {}),
    } as RichTextBlock;
  };

  return {
    version: 2,
    doc: {
      type: "doc",
      content: value.doc.content.map(
        (node) => normalize(node) as RichTextBlock,
      ),
    },
  };
}

const hasHighlight = (node: RichTextBlock | RichTextV2Inline): boolean => {
  if (node.type === "text") {
    return node.marks?.some((mark) => mark.type === "highlight") ?? false;
  }

  return node.type !== "hardBreak" && (node.content ?? []).some(hasHighlight);
};

/** Unknown versions require a newer client too, even if its restore stripped the field. */
export function supportsRichTextWrite(
  elements: unknown[],
  capability: unknown,
): boolean {
  return elements.every((element) => {
    if (!object(element) || element.richText === undefined) return true;
    if (!object(element.richText)) {
      return capability === 1 || capability === 2 || capability === 3;
    }

    const version = element.richText.version;

    // Guard the current document as well as the incoming one: stale clients may
    // submit a pre-highlight snapshot with the new mark already missing.
    if (
      capability !== 3 &&
      isRichTextV2(element.richText) &&
      element.richText.doc.content.some(hasHighlight)
    ) {
      return false;
    }

    return (
      (capability === 1 && version === 1) ||
      ((capability === 2 || capability === 3) &&
        (version === 1 || version === 2))
    );
  });
}
