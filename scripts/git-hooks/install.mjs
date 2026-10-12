// Install into the common Git directory so every worktree keeps its own checks
// while sharing one dispatcher. Never change global Git configuration.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const uninstall = process.argv.includes("--uninstall");
const git = (...args) => spawnSync("git", args, { encoding: "utf8" });
const inside = git("rev-parse", "--is-inside-work-tree");

if (inside.status !== 0 || inside.stdout.trim() !== "true") {
  console.log("Project hooks: skipped (no Git worktree).");
  process.exit(0);
}

if (!uninstall && (process.env.CI || process.env.SKIP_PROJECT_HOOKS === "1")) {
  console.log("Project hooks: skipped (CI / SKIP_PROJECT_HOOKS).");
  process.exit(0);
}

// A per-worktree override takes precedence over shared config. Do not overwrite
// someone's explicit override or report an installation that cannot take effect.
if (
  git(
    "config",
    "--bool",
    "--get",
    "extensions.worktreeConfig",
  ).stdout.trim() === "true" &&
  git("config", "--worktree", "--get", "core.hooksPath").status === 0
) {
  throw new Error(
    "This worktree overrides core.hooksPath; remove its config.worktree override before installing shared project hooks.",
  );
}

const common = resolve(git("rev-parse", "--git-common-dir").stdout.trim());
const target = join(common, "workspace-hooks");
const statePath = join(target, "state.json");
const local = git("config", "--local", "--get", "core.hooksPath");
const effective = git("config", "--path", "--get", "core.hooksPath");
const previous = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : null;

function configure(...args) {
  const result = git("config", "--local", ...args);

  if (result.status !== 0) {
    throw new Error(result.stderr || "Could not configure project hooks");
  }
}

if (uninstall) {
  if (!previous) {
    console.log("Project hooks: already uninstalled.");
    process.exit(0);
  }

  if (local.stdout.trim() !== target) {
    throw new Error(
      "core.hooksPath changed after installation; restore it before uninstalling.",
    );
  }

  if (previous.localPath === null) {
    configure("--unset", "core.hooksPath");
  } else {
    configure("core.hooksPath", previous.localPath);
  }

  rmSync(target, { recursive: true });
  console.log("Project hooks: removed; previous hooks configuration restored.");
  process.exit(0);
}

if (previous && effective.stdout.trim() !== target) {
  throw new Error(
    "Project hooks state exists but core.hooksPath changed; restore it before reinstalling.",
  );
}

const state = previous ?? {
  localPath: local.status === 0 ? local.stdout.trim() : null,
  previousPath:
    effective.status === 0 ? effective.stdout.trim() : join(common, "hooks"),
};

if (state.previousPath === target) {
  throw new Error("Refusing a recursive hook chain.");
}

mkdirSync(target, { recursive: true });
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
writeFileSync(
  join(target, "run.mjs"),
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run.mjs")),
);
// Git invokes additional hooks too: preserve the whole previous hook directory.
const hooks = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "post-receive",
  "post-update",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "reference-transaction",
  "proc-receive",
  "post-index-change",
];

for (const hook of hooks) {
  writeFileSync(
    join(target, hook),
    `#!/bin/sh\nexec node "$(dirname "$0")/run.mjs" ${hook} "$@"\n`,
    { mode: 0o755 },
  );
}

configure("core.hooksPath", target);
console.log(
  "Project hooks: installed; existing hooks run first in every worktree.",
);
