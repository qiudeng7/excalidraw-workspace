import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";
import vueParser from "vue-eslint-parser";

// Prettier handles spacing and indentation; these rules add logical blank lines.
const rules = {
  "no-restricted-syntax": [
    "error",
    {
      selector: "CatchClause[param=null]",
      message: "catch 必须捕获异常，并进行重抛、反馈或明确的降级处理。",
    },
    {
      selector: "CatchClause > BlockStatement[body.length=0]",
      message: "禁止空 catch 或仅有注释的 catch，必须实际处理异常。",
    },
    {
      selector:
        "CatchClause > BlockStatement > ExpressionStatement > UnaryExpression[operator='void']",
      message: "不能用 void 假装处理异常，请重抛、报告或明确处理失败。",
    },
  ],
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      vars: "local",
      varsIgnorePattern: ".*",
      args: "none",
      caughtErrors: "all",
    },
  ],
  "@stylistic/padding-line-between-statements": [
    "error",
    { blankLine: "always", prev: "import", next: "*" },
    { blankLine: "any", prev: "import", next: "import" },
    { blankLine: "always", prev: "*", next: "return" },
    {
      blankLine: "always",
      prev: "*",
      next: ["function", "class", "interface", "type", "export"],
    },
    {
      blankLine: "always",
      prev: ["function", "class", "interface", "type", "block-like"],
      next: "*",
    },
    { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
    {
      blankLine: "any",
      prev: ["const", "let", "var"],
      next: ["const", "let", "var"],
    },
  ],
  "@stylistic/lines-between-class-members": [
    "error",
    {
      enforce: [
        { blankLine: "always", prev: "method", next: "*" },
        { blankLine: "always", prev: "*", next: "method" },
      ],
    },
  ],
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      ".nuxt/**",
      ".output/**",
      ".wrangler/**",
      ".data/**",
      "**/dist/**",
      "**/dist-ssr/**",
      "**/.cache/**",
      "**/coverage/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue}"],
    // Formatting does not interpret upstream directives for unrelated lint rules.
    linterOptions: { noInlineConfig: true },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "@stylistic": stylistic, "@typescript-eslint": tseslint.plugin },
    rules,
  },
  {
    files: ["**/*.{js,mjs,cjs,jsx}"],
    rules: {
      // JS scripts keep Prettier spacing without migrating historical blank lines.
      "@stylistic/padding-line-between-statements": "off",
      "@stylistic/lines-between-class-members": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": rules["@typescript-eslint/no-unused-vars"],
    },
  },
  {
    files: ["**/*.{ts,mts,cts,tsx}"],
    languageOptions: { parser: tseslint.parser },
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, extraFileExtensions: [".vue"] },
    },
  },
];
