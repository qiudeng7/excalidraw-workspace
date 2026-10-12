import { test } from "node:test";
import assert from "node:assert/strict";
import { ESLint } from "eslint";

const aliasRules = new Set([
  "no-restricted-imports",
  "no-restricted-modules",
  "no-restricted-syntax",
]);

test("application imports use Nuxt aliases across scripts, Vue, re-exports and type queries", async () => {
  const eslint = new ESLint();
  const cases = [
    ["static", 'import { value } from "./module";', true],
    ["parent", 'import type { User } from "../../shared/contracts";', true],
    ["side effect", 'import "./initialize";', true],
    ["re-export", 'export { value } from "../module";', true],
    ["export all", 'export * from "./module";', true],
    ["dynamic", 'const load = () => import("./module");', true],
    ["template", "const load = () => import(`../module`);", true],
    ["type query", 'type User = import("../contracts").User;', true],
    ["require", 'const value = require("./module");', true],
    ["nested require", 'const value = require("../../shared/module");', true],
    ["source alias", 'import { value } from "~/lib/module";', false],
    ["server alias", 'export * from "#server/utils/module";', false],
    ["shared alias", 'import type { User } from "#shared/contracts";', false],
    ["dynamic alias", 'const load = () => import("~/lib/module");', false],
    ["type alias", 'type User = import("#shared/contracts").User;', false],
    ["root alias", 'import data from "~~/package.json";', false],
    ["package", 'import { ref } from "vue";', false],
    ["built-in", 'import { randomUUID } from "node:crypto";', false],
  ] as const;

  for (const directory of ["src", "server", "shared"]) {
    for (const extension of ["ts", "tsx", "mjs", "vue"]) {
      for (const [name, source, rejected] of cases) {
        const code =
          extension === "vue"
            ? `<script setup lang="ts">${source}</script>`
            : source;

        // JavaScript files do not accept TypeScript-only declarations.
        if (extension === "mjs" && /import type|^type /.test(source)) continue;
        const [result] = await eslint.lintText(code, {
          filePath: `${directory}/alias-fixture.${extension}`,
        });

        assert.equal(
          result!.fatalErrorCount,
          0,
          `${directory}/${extension}: ${name}`,
        );
        assert.equal(
          result!.messages.some((message) => aliasRules.has(message.ruleId!)),
          rejected,
          `${directory}/${extension}: ${name}`,
        );
      }
    }
  }
});

test("standalone packages and test entries keep relative imports; only the Worker build entry is exempt", async () => {
  const eslint = new ESLint();

  for (const filePath of [
    "packages/excalidraw/example.ts",
    "tests/unit/example.ts",
    "scripts/example.mjs",
  ]) {
    const [result] = await eslint.lintText(
      'import { value } from "./module";',
      { filePath },
    );

    assert.equal(result!.errorCount, 0, filePath);
  }

  for (const [source, rejected] of [
    ['import nitro from "../.output/server/index.mjs";', false],
    [
      'export { CanvasRoom } from "#server/collaboration/durable-object";',
      false,
    ],
    ['export { CanvasRoom } from "./collaboration/durable-object";', true],
    ['import other from "../.output/server/other.mjs";', true],
  ] as const) {
    const [result] = await eslint.lintText(source, {
      filePath: "server/worker.mjs",
    });

    assert.equal(
      result!.messages.some(
        (message) => message.ruleId === "no-restricted-imports",
      ),
      rejected,
      source,
    );
  }
});
