import MarkdownIt from "markdown-it";
// @ts-expect-error markdown-it only publishes types for its public parser, not builtin rules.
import markdownImage from "markdown-it/lib/rules_inline/image.mjs";
import {
  chainCommands,
  createParagraphNear,
  exitCode,
  liftEmptyBlock,
  newlineInCode,
  splitBlock,
} from "prosemirror-commands";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { MarkdownParser } from "prosemirror-markdown";
import { Schema } from "prosemirror-model";
import {
  splitListItem,
  liftListItem,
  sinkListItem,
} from "prosemirror-schema-list";
import type { Command } from "prosemirror-state";
import { isSafeRichTextLink } from "../lib/element/src/richTextDocument";

export const richTextSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }],
    },
    heading: {
      content: "inline*",
      group: "block",
      defining: true,
      attrs: { level: { default: 1 } },
      toDOM: (node) => [`h${node.attrs.level}`, 0],
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
        tag: `h${level}`,
        attrs: { level },
      })),
    },
    blockquote: {
      content: "block+",
      group: "block",
      defining: true,
      toDOM: () => ["blockquote", 0],
      parseDOM: [{ tag: "blockquote" }],
    },
    bulletList: {
      content: "listItem+",
      group: "block",
      toDOM: () => ["ul", 0],
      parseDOM: [{ tag: "ul" }],
    },
    orderedList: {
      content: "listItem+",
      group: "block",
      attrs: { order: { default: 1 } },
      toDOM: (node) => ["ol", { start: node.attrs.order }, 0],
      parseDOM: [
        {
          tag: "ol",
          getAttrs: (node) => ({
            order: Number(node.getAttribute("start") || 1),
          }),
        },
      ],
    },
    listItem: {
      content: "paragraph block*",
      defining: true,
      toDOM: () => ["li", 0],
      parseDOM: [{ tag: "li" }],
    },
    codeBlock: {
      content: "text*",
      group: "block",
      code: true,
      marks: "",
      defining: true,
      attrs: { params: { default: "" } },
      toDOM: () => ["pre", ["code", 0]],
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
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
      toDOM: () => ["strong", 0],
      parseDOM: [{ tag: "strong" }, { tag: "b" }],
    },
    italic: {
      toDOM: () => ["em", 0],
      parseDOM: [{ tag: "em" }, { tag: "i" }],
    },
    code: {
      code: true,
      excludes: "_",
      toDOM: () => ["code", 0],
      parseDOM: [{ tag: "code" }],
    },
    strike: {
      toDOM: () => ["s", 0],
      parseDOM: [{ tag: "s" }, { tag: "del" }],
    },
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      toDOM: (mark) => [
        "a",
        { href: mark.attrs.href, title: mark.attrs.title },
        0,
      ],
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (node) =>
            isSafeRichTextLink(node.getAttribute("href") || "")
              ? {
                  href: node.getAttribute("href"),
                  title: node.getAttribute("title"),
                }
              : false,
        },
      ],
    },
  },
});

// Keep unsupported constructs literal, including HTML, images and horizontal rules.
// The commonmark preset has no table extension or syntax highlighting.
const markdown = new MarkdownIt("commonmark", { html: false })
  .enable("strikethrough")
  .disable(["hr"]);

markdown.inline.ruler.at("image", (state, silent) => {
  const start = state.pos;

  if (!markdownImage(state, silent)) return false;
  if (!silent) {
    const token = state.tokens[state.tokens.length - 1];

    token.type = "text";
    token.tag = "";
    token.attrs = null;
    token.children = null;
    token.content = state.src.slice(start, state.pos);
  }

  return true;
});
markdown.validateLink = isSafeRichTextLink;
// Match the existing literal-text import convention, preserving code-block tabs.
markdown.core.ruler.after("inline", "rich_text_inline_tabs", (state) => {
  for (const block of state.tokens) {
    for (const token of block.children || []) {
      if (token.type === "text" || token.type === "code_inline") {
        token.content = token.content.replace(/\t/g, "        ");
      }
    }
  }
});
const markdownParser = new MarkdownParser(richTextSchema, markdown, {
  paragraph: { block: "paragraph" },
  blockquote: { block: "blockquote" },
  heading: {
    block: "heading",
    getAttrs: (token) => ({ level: Number(token.tag.slice(1)) }),
  },
  bullet_list: { block: "bulletList" },
  ordered_list: {
    block: "orderedList",
    getAttrs: (token) => ({
      order: Math.max(1, Number(token.attrGet("start") || 1)),
    }),
  },
  list_item: { block: "listItem" },
  code_block: { block: "codeBlock", noCloseToken: true },
  fence: {
    block: "codeBlock",
    getAttrs: (token) => ({ params: token.info || "" }),
    noCloseToken: true,
  },
  hardbreak: { node: "hardBreak" },
  softbreak: { node: "hardBreak" },
  em: { mark: "italic" },
  strong: { mark: "bold" },
  s: { mark: "strike" },
  code_inline: { mark: "code", noCloseToken: true },
  link: {
    mark: "link",
    getAttrs: (token) => ({
      href: token.attrGet("href"),
      title: token.attrGet("title"),
    }),
  },
});

export const parseRichTextMarkdown = (text: string) =>
  markdownParser.parse(text);

const markInputRule = (regexp: RegExp, mark: string, delimiterLength: number) =>
  new InputRule(regexp, (state, match, start, end) => {
    if (start > 1 && state.doc.textBetween(start - 1, start) === "\\")
      return null;
    const transaction = state.tr
      .delete(end - delimiterLength + 1, end)
      .delete(start, start + delimiterLength);

    transaction.addMark(
      start,
      start + match[1].length,
      richTextSchema.marks[mark].create(),
    );

    return transaction.removeStoredMark(richTextSchema.marks[mark]);
  });

export const richTextInputRules = () =>
  inputRules({
    rules: [
      wrappingInputRule(/^\s*>\s$/, richTextSchema.nodes.blockquote),
      wrappingInputRule(/^\s*([-+*])\s$/, richTextSchema.nodes.bulletList),
      wrappingInputRule(
        /^(\d{1,9})\.\s$/,
        richTextSchema.nodes.orderedList,
        (match) => ({ order: Math.max(1, Number(match[1])) }),
        (match, node) =>
          node.childCount + node.attrs.order === Number(match[1]),
      ),
      textblockTypeInputRule(
        /^(#{1,6})\s$/,
        richTextSchema.nodes.heading,
        (match) => ({ level: match[1].length }),
      ),
      textblockTypeInputRule(
        /^```([\w+-]*)\s$/,
        richTextSchema.nodes.codeBlock,
        (match) => ({ params: match[1] }),
      ),
      markInputRule(/\*\*([^*\n]+)\*\*$/, "bold", 2),
      markInputRule(/__([^_\n]+)__$/, "bold", 2),
      markInputRule(/(?<!\*)\*([^*\n]+)\*$/, "italic", 1),
      markInputRule(/(?<![\w_])_([^_\n]+)_$/, "italic", 1),
      markInputRule(/`([^`\n]+)`$/, "code", 1),
      markInputRule(/~~([^~\n]+)~~$/, "strike", 2),
      new InputRule(
        /(?<!!)\[([^\]\n]+)\]\(([^\s)]+)(?:\s+"([^"\n]*)")?\)$/,
        (state, match, start, end) => {
          if (
            !markdown.validateLink(match[2]) ||
            (start > 1 && state.doc.textBetween(start - 1, start) === "\\")
          )
            return null;

          return state.tr
            .replaceWith(
              start,
              end,
              richTextSchema.text(match[1], [
                richTextSchema.marks.link.create({
                  href: match[2],
                  title: match[3] || null,
                }),
              ]),
            )
            .removeStoredMark(richTextSchema.marks.link);
        },
      ),
    ],
  });

const enterFence: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;

  if (
    !empty ||
    $from.parent.type !== richTextSchema.nodes.paragraph ||
    $from.parentOffset !== $from.parent.content.size
  )
    return false;
  const match = /^```([\w+-]*)$/.exec($from.parent.textContent);

  if (!match) return false;
  dispatch?.(
    state.tr
      .delete($from.start(), $from.end())
      .setBlockType(
        $from.before(),
        $from.before() + 2,
        richTextSchema.nodes.codeBlock,
        {
          params: match[1],
        },
      ),
  );

  return true;
};

const exitCodeAtEnd: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection;

  if (
    !empty ||
    !$from.parent.type.spec.code ||
    $from.parentOffset !== $from.parent.content.size
  )
    return false;

  return exitCode(state, dispatch, view);
};

export const richTextKeymapCommands: Record<string, Command> = {
  Enter: chainCommands(
    enterFence,
    newlineInCode,
    splitListItem(richTextSchema.nodes.listItem),
    createParagraphNear,
    liftEmptyBlock,
    splitBlock,
  ),
  ArrowDown: exitCodeAtEnd,
  Tab: sinkListItem(richTextSchema.nodes.listItem),
  "Shift-Tab": liftListItem(richTextSchema.nodes.listItem),
};
