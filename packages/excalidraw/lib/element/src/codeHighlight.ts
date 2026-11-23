import type { LanguageFn } from "highlight.js";
import { createLowlight } from "lowlight";

/** Semantic token classes; punctuation and operators keep the element color. */
export type CodeTokenKind =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "literal"
  | "function"
  | "type"
  | "attr"
  | "tag"
  | "variable"
  | "meta"
  | "section";

export interface CodeToken {
  start: number;
  end: number;
  kind: CodeTokenKind;
}

/** Light-theme colors; renderers pass them through the canvas dark-mode filter. */
const CODE_TOKEN_COLORS: Record<CodeTokenKind, string> = {
  keyword: "#7c3aed",
  string: "#15803d",
  comment: "#6b7280",
  number: "#b45309",
  literal: "#b91c1c",
  function: "#1d4ed8",
  type: "#0e7490",
  attr: "#9a3412",
  tag: "#b91c1c",
  variable: "#a21caf",
  meta: "#6b7280",
  section: "#1d4ed8",
};

export const codeTokenColor = (kind: CodeTokenKind) => CODE_TOKEN_COLORS[kind];

interface LanguageDefinition {
  /** Loaded on first use, so every grammar ships as its own chunk. */
  load: () => Promise<{ default: LanguageFn }>;
  /** Fence infos people actually type. */
  aliases: string[];
}

const LANGUAGES: Record<string, LanguageDefinition> = {
  bash: {
    load: () => import("highlight.js/lib/languages/bash"),
    aliases: ["sh", "shell", "zsh", "console", "shellsession"],
  },
  c: { load: () => import("highlight.js/lib/languages/c"), aliases: ["h"] },
  cpp: {
    load: () => import("highlight.js/lib/languages/cpp"),
    aliases: ["c++", "cc", "hpp", "hxx"],
  },
  csharp: {
    load: () => import("highlight.js/lib/languages/csharp"),
    aliases: ["cs", "c#"],
  },
  css: { load: () => import("highlight.js/lib/languages/css"), aliases: [] },
  diff: { load: () => import("highlight.js/lib/languages/diff"), aliases: [] },
  dockerfile: {
    load: () => import("highlight.js/lib/languages/dockerfile"),
    aliases: ["docker"],
  },
  go: { load: () => import("highlight.js/lib/languages/go"), aliases: [] },
  ini: {
    load: () => import("highlight.js/lib/languages/ini"),
    aliases: ["toml", "conf"],
  },
  java: { load: () => import("highlight.js/lib/languages/java"), aliases: [] },
  javascript: {
    load: () => import("highlight.js/lib/languages/javascript"),
    aliases: ["js", "jsx", "mjs", "cjs", "node"],
  },
  json: {
    load: () => import("highlight.js/lib/languages/json"),
    aliases: ["jsonc", "json5"],
  },
  kotlin: {
    load: () => import("highlight.js/lib/languages/kotlin"),
    aliases: ["kt", "kts"],
  },
  markdown: {
    load: () => import("highlight.js/lib/languages/markdown"),
    aliases: ["md", "mdown"],
  },
  php: {
    load: () => import("highlight.js/lib/languages/php"),
    aliases: ["php3", "php4", "php5"],
  },
  python: {
    load: () => import("highlight.js/lib/languages/python"),
    aliases: ["py", "gyp", "ipython"],
  },
  ruby: {
    load: () => import("highlight.js/lib/languages/ruby"),
    aliases: ["rb", "gemfile", "gemspec"],
  },
  rust: {
    load: () => import("highlight.js/lib/languages/rust"),
    aliases: ["rs"],
  },
  scss: {
    load: () => import("highlight.js/lib/languages/scss"),
    aliases: ["less", "sass"],
  },
  sql: {
    load: () => import("highlight.js/lib/languages/sql"),
    aliases: ["mysql", "pgsql", "postgres", "postgresql", "sqlite"],
  },
  swift: {
    load: () => import("highlight.js/lib/languages/swift"),
    aliases: [],
  },
  typescript: {
    load: () => import("highlight.js/lib/languages/typescript"),
    aliases: ["ts", "tsx", "mts", "cts"],
  },
  xml: {
    load: () => import("highlight.js/lib/languages/xml"),
    aliases: ["html", "htm", "xhtml", "svg", "vue", "xml"],
  },
  yaml: {
    load: () => import("highlight.js/lib/languages/yaml"),
    aliases: ["yml"],
  },
};

const ALIASES = new Map<string, string>();

for (const [name, definition] of Object.entries(LANGUAGES)) {
  ALIASES.set(name, name);
  for (const alias of definition.aliases) ALIASES.set(alias, name);
}

const lowlight = createLowlight();
const loadedLanguages = new Set<string>();
const failedLanguages = new Set<string>();
const pendingLanguages = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

/**
 * Bumped whenever a grammar finishes loading; layout caches include it so text
 * measured as plain is re-measured with syntax colors.
 */
export const codeHighlightVersion = () => version;

export const onCodeHighlightReady = (listener: () => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

/** Fence info may carry extra words (`js title=…`); only the first word is a language. */
export const resolveCodeLanguage = (params?: string | null) => {
  const name = (params ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "")
    .split(/\s+/)[0];

  return name ? (ALIASES.get(name) ?? null) : null;
};

/** The alias table stays static, so a fence resolves before anything downloads. */
export const loadCodeLanguage = (language: string) => {
  const name = ALIASES.get(language.toLowerCase()) ?? language;
  const definition = LANGUAGES[name];

  if (!definition || loadedLanguages.has(name) || failedLanguages.has(name)) {
    return Promise.resolve();
  }

  const pending = pendingLanguages.get(name);

  if (pending) return pending;

  const promise = definition
    .load()
    .then((module) => {
      lowlight.register(name, module.default);
      loadedLanguages.add(name);
      version += 1;
      cache.clear();
      for (const listener of listeners) listener();
    })
    .catch((error) => {
      failedLanguages.add(name);
      console.warn(`代码高亮语法加载失败：${name}`, error);
    })
    .finally(() => {
      pendingLanguages.delete(name);
    });

  pendingLanguages.set(name, promise);

  return promise;
};

// highlight.js class list of a token, most specific first.
const CLASS_KINDS: Record<string, CodeTokenKind> = {
  "hljs-title.function_": "function",
  "hljs-title.class_": "type",
  "hljs-keyword": "keyword",
  "hljs-selector-tag": "keyword",
  "hljs-selector-pseudo": "keyword",
  "hljs-string": "string",
  "hljs-regexp": "string",
  "hljs-char": "string",
  "hljs-symbol": "string",
  "hljs-link": "string",
  "hljs-addition": "string",
  "hljs-comment": "comment",
  "hljs-quote": "comment",
  "hljs-number": "number",
  "hljs-literal": "literal",
  "hljs-deletion": "literal",
  "hljs-built_in": "type",
  "hljs-type": "type",
  "hljs-class": "type",
  "hljs-title": "function",
  "hljs-attr": "attr",
  "hljs-attribute": "attr",
  "hljs-property": "attr",
  "hljs-selector-attr": "attr",
  "hljs-variable": "variable",
  "hljs-template-variable": "variable",
  "hljs-params": "variable",
  "hljs-tag": "tag",
  "hljs-name": "tag",
  "hljs-meta": "meta",
  "hljs-doctag": "meta",
  "hljs-section": "section",
};

type HastNode = {
  type: string;
  value?: string;
  children?: HastNode[];
  properties?: { className?: unknown };
  tagName?: string;
};

const classKind = (classes: unknown): CodeTokenKind | null => {
  if (!Array.isArray(classes)) return null;
  const names = classes.filter(
    (name): name is string => typeof name === "string",
  );
  const suffix = names.includes("function_")
    ? "function_"
    : names.includes("class_")
      ? "class_"
      : null;

  if (suffix) {
    const specific = CLASS_KINDS[`hljs-title.${suffix}`];

    if (specific) return specific;
  }

  for (const name of names) {
    const kind = CLASS_KINDS[name];

    if (kind) return kind;
  }

  return null;
};

type DepthToken = CodeToken & { depth: number };

const collectTokens = (
  node: HastNode,
  offset: number,
  depth: number,
  tokens: DepthToken[],
): number => {
  if (node.type === "text") return offset + (node.value?.length ?? 0);

  const start = offset;
  let cursor = offset;

  for (const child of node.children ?? []) {
    cursor = collectTokens(child, cursor, depth + 1, tokens);
  }

  if (node.type === "element") {
    const kind = classKind(node.properties?.className);

    if (kind && cursor > start)
      tokens.push({ start, end: cursor, kind, depth });
  }

  return cursor;
};

/**
 * Splits highlighted ranges into non-overlapping segments. Nested highlight.js
 * tokens (an escape inside a string, a type inside a function signature) keep
 * the innermost kind.
 */
const flattenTokens = (tokens: DepthToken[], length: number): CodeToken[] => {
  const boundaries = new Set<number>([0, length]);

  for (const token of tokens) {
    boundaries.add(token.start);
    boundaries.add(token.end);
  }

  const points = [...boundaries].sort((a, b) => a - b);
  const result: CodeToken[] = [];

  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index];
    const end = points[index + 1];
    let best: DepthToken | undefined;

    for (const token of tokens) {
      if (token.start > start || token.end < end) continue;
      if (!best || token.depth >= best.depth) best = token;
    }

    if (!best) continue;
    const previous = result[result.length - 1];

    if (previous && previous.end === start && previous.kind === best.kind) {
      previous.end = end;
    } else {
      result.push({ start, end, kind: best.kind });
    }
  }

  return result;
};

/** Punctuation-only spans read better in the element color than in a token hue. */
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}_$]+$/u;

const polishTokens = (tokens: CodeToken[], code: string): CodeToken[] => {
  const result: CodeToken[] = [];

  for (const token of tokens) {
    let start = token.start;
    let end = token.end;

    while (start < end && /\s/.test(code[start])) start++;
    while (end > start && /\s/.test(code[end - 1])) end--;
    if (start >= end || PUNCTUATION_ONLY.test(code.slice(start, end))) continue;
    result.push({ start, end, kind: token.kind });
  }

  return result;
};

const cache = new Map<string, CodeToken[] | null>();
const CACHE_LIMIT = 200;

/**
 * Tokens for a fenced code block. Returns `null` while the grammar is still
 * downloading (the block renders as plain text) or when the language is
 * unknown, and never throws on odd input.
 */
export const highlightCode = (
  code: string,
  params?: string | null,
): CodeToken[] | null => {
  const language = resolveCodeLanguage(params);

  if (!language || !code) return null;

  if (!loadedLanguages.has(language)) {
    void loadCodeLanguage(language);

    return null;
  }

  const key = `${language}\u0000${code}`;
  const cached = cache.get(key);

  if (cached !== undefined) return cached;

  let result: CodeToken[] | null = null;

  try {
    const tree = lowlight.highlight(language, code) as unknown as HastNode;
    const collected: DepthToken[] = [];

    collectTokens(tree, 0, 0, collected);
    const flattened = collected.length
      ? polishTokens(flattenTokens(collected, code.length), code)
      : [];

    result = flattened.length ? flattened : null;
  } catch (error) {
    // A broken grammar degrades to unhighlighted text instead of breaking layout.
    console.warn("代码高亮失败，已按纯文本渲染", error);
    result = null;
  }

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, result);

  return result;
};
