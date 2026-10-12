import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixture } from "./fixture.mjs";

test("staged snapshot protects partial staging, filenames with spaces and unstaged config", (t) => {
  const f = fixture(t);
  const file = "source with spaces.mjs";
  const valid = 'export const value = "staged";\n';
  const unstaged = 'export const value="unstaged"\n';

  writeFileSync(join(f.root, file), valid);
  f.git("add", file);
  writeFileSync(join(f.root, file), unstaged);
  writeFileSync(join(f.root, "eslint.config.mjs"), "invalid unstaged config {");
  const before = f.git("write-tree");
  const result = f.run(process.execPath, ["scripts/check-staged.mjs"]);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(readFileSync(join(f.root, file), "utf8"), unstaged);
  assert.equal(f.git("show", `:${file}`), valid.trim());
  assert.equal(f.git("write-tree"), before);
});

test("staged lint, format and whitespace failures do not change the index", (t) => {
  const f = fixture(t);

  for (const source of [
    "try { work(); } catch (error) {}\n",
    'export const value="wrong format"\n',
    'export const value = "space"; \n',
  ]) {
    writeFileSync(join(f.root, "invalid.mjs"), source);
    f.git("add", "invalid.mjs");
    const before = f.git("write-tree");
    const result = f.run(process.execPath, ["scripts/check-staged.mjs"]);

    assert.notEqual(result.status, 0);
    assert.equal(f.git("write-tree"), before);
    assert.equal(readFileSync(join(f.root, "invalid.mjs"), "utf8"), source);
  }
});

test("renames are checked while deletion-only and empty indexes pass", (t) => {
  const f = fixture(t);

  assert.equal(f.run(process.execPath, ["scripts/check-staged.mjs"]).status, 0);
  f.git("rm", "package.json");
  assert.equal(f.run(process.execPath, ["scripts/check-staged.mjs"]).status, 0);
  const source = "rename source.mjs";

  writeFileSync(join(f.root, source), 'export const value = "rename";\n');
  f.git("add", source);
  const commit = f.git(
    "commit-tree",
    f.git("write-tree"),
    "-m",
    "rename source fixture",
  );

  f.git("update-ref", "HEAD", commit);
  renameSync(join(f.root, source), join(f.root, "renamed script.mjs"));
  f.git("add", "-A");
  assert.match(f.git("diff", "--cached", "--name-status"), /R100/);
  const result = f.run(process.execPath, ["scripts/check-staged.mjs"]);

  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("staged ESLint configuration checks its complete code scope", (t) => {
  const f = fixture(t);

  writeFileSync(
    join(f.root, "existing.mjs"),
    "try { work(); } catch (error) {}\n",
  );
  f.git("add", "existing.mjs");
  const commit = f.git(
    "commit-tree",
    f.git("write-tree"),
    "-m",
    "existing source fixture",
  );

  f.git("update-ref", "HEAD", commit);
  const config = join(f.root, "eslint.config.mjs");

  writeFileSync(
    config,
    readFileSync(config, "utf8") + "\n// Config change fixture.\n",
  );
  f.git("add", "eslint.config.mjs");
  const result = f.run(process.execPath, ["scripts/check-staged.mjs"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /existing.mjs/);
});
