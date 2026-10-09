import { test } from "node:test";
import assert from "node:assert/strict";
import { ESLint } from "eslint";

test("catch policy rejects silent errors in TypeScript, TSX and Vue", async () => {
  const eslint = new ESLint();
  const cases: readonly (readonly [string, string, boolean])[] = [
    ["empty", "try { work(); } catch (error) {}", true],
    ["comment", "try { work(); } catch (error) { /* ignored */ }", true],
    ["missing binding", "try { work(); } catch { fallback(); }", true],
    ["unused error", "try { work(); } catch (error) { fallback(); }", true],
    ["renamed error", "try { work(); } catch (_error) { fallback(); }", true],
    ["void error", "try { work(); } catch (error) { void error; }", true],
    [
      "inline suppression",
      "/* eslint-disable no-restricted-syntax, @typescript-eslint/no-unused-vars */ try { work(); } catch (error) {}",
      true,
    ],
    [
      "logged",
      "try { work(); } catch (error) { console.error(error); }",
      false,
    ],
    ["rethrown", "try { work(); } catch (error) { throw error; }", false],
    [
      "wrapped cause",
      'try { work(); } catch (error) { throw new Error("failed", { cause: error }); }',
      false,
    ],
  ];

  for (const extension of ["ts", "tsx", "vue"]) {
    for (const [name, source, invalid] of cases) {
      const code =
        extension === "vue"
          ? `<script setup lang="ts">${source}</script>`
          : source;
      const [result] = await eslint.lintText(code, {
        filePath: `src/error-policy-fixture.${extension}`,
      });
      const errors = result!.messages.filter(
        (message) =>
          message.ruleId === "no-restricted-syntax" ||
          message.ruleId === "@typescript-eslint/no-unused-vars",
      );

      assert.equal(errors.length > 0, invalid, `${extension}: ${name}`);
    }
  }
});
