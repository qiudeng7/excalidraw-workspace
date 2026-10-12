import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "workspace-hooks-test-"));
  const root = join(directory, "repo");
  const original = join(directory, "original hooks");
  const bin = join(directory, "bin");
  const log = join(directory, "events.log");
  const globalConfig = join(directory, "gitconfig");

  for (const path of [root, original, bin]) mkdirSync(path);
  writeFileSync(globalConfig, "");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${bin}:${process.env.PATH}`,
    CI: "",
    SKIP_PROJECT_HOOKS: "",
    HOOK_TEST_LOG: log,
  };

  function run(command, args, options = {}) {
    return spawnSync(command, args, {
      cwd: root,
      env,
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
  git("config", "user.name", "Hook fixture");
  git("config", "user.email", "hooks@example.invalid");
  git("config", "--global", "core.hooksPath", original);
  cpSync(join(project, "scripts"), join(root, "scripts"), { recursive: true });
  cpSync(join(project, "tests/http"), join(root, "tests/http"), {
    recursive: true,
  });
  for (const file of [
    "eslint.config.mjs",
    ".prettierrc.json",
    ".prettierignore",
  ])
    cpSync(join(project, file), join(root, file));
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  symlinkSync(
    join(project, "node_modules"),
    join(root, "node_modules"),
    "junction",
  );
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  git("add", ".");
  const tree = git("write-tree");
  const commit = git("commit-tree", tree, "-m", "fixture");

  git("update-ref", "refs/heads/main", commit);

  function install(options = {}) {
    return run(
      process.execPath,
      [join(root, "scripts/git-hooks/install.mjs"), ...(options.args ?? [])],
      options.spawn,
    );
  }

  function hook(name, body) {
    writeFileSync(
      join(original, name),
      `#!/bin/sh\nprintf 'original:${name}\\n' >> "$HOOK_TEST_LOG"\n${body}\n`,
      { mode: 0o755 },
    );
  }

  writeFileSync(
    join(bin, "pnpm"),
    `#!${process.execPath}\nimport { appendFileSync, readFileSync, writeFileSync } from 'node:fs';\nappendFileSync(process.env.HOOK_TEST_LOG, 'project:' + process.argv[2] + '\\n');\nif (process.argv[2] === 'check:pre-push') writeFileSync(process.env.HOOK_TEST_LOG + '.project-input', readFileSync(0));\nprocess.exit(Number(process.env.HOOK_TEST_PROJECT_EXIT ?? 0));\n`,
    { mode: 0o755 },
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  return {
    root,
    directory,
    original,
    env,
    run,
    git,
    install,
    hook,
    log,
    events: () => readFileSync(log, "utf8"),
  };
}
