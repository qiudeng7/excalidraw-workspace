// Check an isolated copy of the Git index. Neither partially staged files nor
// concurrent edits in the worktree are rewritten or temporarily stashed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });

  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);

  return result.stdout;
}

const root = run("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
}).trim();

run("git", ["diff", "--cached", "--check"], { cwd: root });

const files = run(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
  {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  },
)
  .split("\0")
  .filter(Boolean);

if (!files.length) process.exit(0);

const snapshot = mkdtempSync(join(tmpdir(), "workspace-index-"));

try {
  run("git", ["checkout-index", "--all", `--prefix=${snapshot}/`], {
    cwd: root,
  });
  symlinkSync(
    join(root, "node_modules"),
    join(snapshot, "node_modules"),
    "junction",
  );

  const code = files.filter((file) =>
    /\.(?:[cm]?js|[cm]?ts|tsx|jsx|vue)$/.test(file),
  );
  // Config changes affect every source file; validate their full lint scope.
  const lintConfig = files.some((file) => file === "eslint.config.mjs");
  const eslint = join(root, "node_modules/eslint/bin/eslint.js");
  const prettier = join(root, "node_modules/prettier/bin/prettier.cjs");

  if (lintConfig || code.length) {
    run(
      process.execPath,
      [eslint, ...(lintConfig ? ["."] : ["--no-warn-ignored", "--", ...code])],
      { cwd: snapshot },
    );
  }

  // Unsupported text formats and binary assets still receive Git whitespace checks.
  run(
    process.execPath,
    [prettier, "--check", "--ignore-unknown", "--", ...files],
    {
      cwd: snapshot,
    },
  );
} finally {
  rmSync(snapshot, { recursive: true, force: true });
}
