// This file is copied next to state.json by the installer. Only pre-push has
// two consumers. Other hooks inherit stdin, including interactive proc-receive.
import { spawnSync } from "node:child_process";
import { constants, accessSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [hook, ...args] = process.argv.slice(2);
const state = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "state.json"),
    "utf8",
  ),
);
const buffered = hook === "pre-push";
const input = buffered ? readFileSync(0) : undefined;

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    input,
    stdio: [buffered ? "pipe" : "inherit", "inherit", "inherit"],
  });

  if (result.error) {
    console.error(`Project hooks: ${result.error.message}`);
  }

  if (result.status !== 0) process.exit(result.status ?? 1);
}

const original = resolve(state.previousPath, hook);
let executable = false;

try {
  accessSync(original, constants.X_OK);
  executable = true;
} catch (error) {
  if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error;
}

if (executable) run(original, args);

if (["pre-commit", "pre-push"].includes(hook)) {
  const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  const root = rootResult.stdout.trim();

  if (
    rootResult.status !== 0 ||
    !existsSync(join(root, "scripts/git-hooks/install.mjs"))
  ) {
    console.error(
      "Project hooks: this worktree has no project checks; existing hook completed.",
    );
  } else {
    run(
      "pnpm",
      [hook === "pre-commit" ? "check:staged" : "check:pre-push"],
      root,
    );
  }
}
