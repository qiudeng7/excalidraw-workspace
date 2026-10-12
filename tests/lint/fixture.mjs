import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "workspace-check-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const globalConfig = join(root, "gitconfig");
  writeFileSync(globalConfig, "");

  function run(command, args, options = {}) {
    return spawnSync(command, args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
      },
      encoding: "utf8",
      ...options,
    });
  }

  function git(...args) {
    const result = run("git", args);
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  git("init", "-b", "main");
  git("config", "user.name", "Check fixture");
  git("config", "user.email", "checks@example.invalid");
  for (const file of [
    "eslint.config.mjs",
    ".prettierrc.json",
    ".prettierignore",
  ])
    cpSync(join(project, file), join(root, file));
  cpSync(join(project, "scripts"), join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  symlinkSync(
    join(project, "node_modules"),
    join(root, "node_modules"),
    "junction",
  );
  writeFileSync(join(root, ".gitignore"), "node_modules\ngitconfig\n");
  git("add", ".");
  const commit = git("commit-tree", git("write-tree"), "-m", "fixture");
  git("update-ref", "refs/heads/main", commit);
  return { root, run, git };
}
