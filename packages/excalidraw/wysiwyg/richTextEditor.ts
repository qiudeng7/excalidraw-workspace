import { Schema } from "prosemirror-model";
import { InputRule, inputRules } from "prosemirror-inputrules";
import type { RichTextMark } from "../lib/element/src/richTextDocument";

const RICH_TEXT_CODE_FONT =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export const richTextSchema = new Schema({
  nodes: {
    doc: { content: "paragraph" },
    paragraph: {
      content: "inline*",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }],
    },
    text: { group: "inline" },
    hardBreak: {
      inline: true,
      group: "inline",
      selectable: false,
      toDOM: () => ["br"],
      parseDOM: [{ tag: "br" }],
    },
  },
  marks: {
    bold: {
      toDOM: () => ["strong", { style: "font-weight:700" }, 0],
      parseDOM: [{ tag: "strong" }, { tag: "b" }],
    },
    italic: {
      toDOM: () => ["em", { style: "font-style:italic" }, 0],
      parseDOM: [{ tag: "em" }, { tag: "i" }],
    },
    code: {
      code: true,
      toDOM: () => [
        "code",
        {
          style: `font-family:${RICH_TEXT_CODE_FONT};font-size:inherit;background:none;padding:0`,
        },
        0,
      ],
      parseDOM: [{ tag: "code" }],
    },
  },
});

const markInputRule = (regexp: RegExp, mark: RichTextMark) =>
  new InputRule(regexp, (state, match, start, end) => {
    if (start > 1 && state.doc.textBetween(start - 1, start) === "\\")
      return null;
    const text = match[1];
    const delimiterLength = mark === "bold" ? 2 : 1;
    // The final delimiter character is handled by the input rule and is not in the document yet.
    // Delete only delimiters so existing nested marks and text nodes survive the conversion.
    const transaction = state.tr
      .delete(end - delimiterLength + 1, end)
      .delete(start, start + delimiterLength);

    transaction.addMark(
      start,
      start + text.length,
      richTextSchema.marks[mark].create(),
    );

    // The next character is ordinary text. Re-enter a style using its keyboard shortcut.
    return transaction.removeStoredMark(richTextSchema.marks[mark]);
  });

export const richTextInputRules = () =>
  inputRules({
    rules: [
      markInputRule(/\*\*([^*\n]+)\*\*$/, "bold"),
      markInputRule(/__([^_\n]+)__$/, "bold"),
      markInputRule(/(?<!\*)\*([^*\n]+)\*$/, "italic"),
      markInputRule(/`([^`\n]+)`$/, "code"),
    ],
  });
