import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixture } from "./fixture.mjs";

test("global hooks run first, failures propagate, and commit-msg is preserved", (t) => {
  const f = fixture(t);

  f.hook("pre-commit", "exit 0");
  f.hook("commit-msg", 'printf "%s" "$1" > "$HOOK_TEST_LOG.message"; exit 19');
  assert.equal(f.install().status, 0);
  assert.equal(f.run("git", ["hook", "run", "pre-commit"]).status, 0);
  assert.equal(f.events(), "original:pre-commit\nproject:check:staged\n");
  assert.equal(
    f.run("git", ["hook", "run", "commit-msg", "--", "message file"]).status,
    19,
  );
  assert.equal(readFileSync(`${f.log}.message`, "utf8"), "message file");
  f.hook("pre-commit", "exit 17");
  writeFileSync(f.log, "");
  assert.equal(f.run("git", ["hook", "run", "pre-commit"]).status, 17);
  assert.equal(f.events(), "original:pre-commit\n");
  f.hook("pre-commit", "exit 0");
  assert.equal(
    f.run("git", ["hook", "run", "pre-commit"], {
      env: { ...f.env, HOOK_TEST_PROJECT_EXIT: "23" },
    }).status,
    23,
  );
});

test("pre-push delivers identical stdin and arguments to both consumers", (t) => {
  const f = fixture(t);
  const input =
    "refs/heads/main abc refs/heads/main def\nrefs/heads/feature 123 refs/heads/feature 456\n";

  writeFileSync(join(f.directory, "push-input"), input);
  f.hook(
    "pre-push",
    'cat > "$HOOK_TEST_LOG.original-input"; printf "%s\\n" "$@" > "$HOOK_TEST_LOG.args"',
  );
  assert.equal(f.install().status, 0);
  assert.equal(
    f.run(
      "git",
      [
        "hook",
        "run",
        "--to-stdin",
        join(f.directory, "push-input"),
        "pre-push",
        "--",
        "origin",
        "example.invalid",
      ],
      { input },
    ).status,
    0,
  );
  assert.equal(readFileSync(`${f.log}.original-input`, "utf8"), input);
  assert.equal(readFileSync(`${f.log}.project-input`, "utf8"), input);
  assert.equal(
    readFileSync(`${f.log}.args`, "utf8"),
    "origin\nexample.invalid\n",
  );
  assert.equal(f.events(), "original:pre-push\nproject:check:pre-push\n");
  assert.equal(
    f.run(
      "git",
      [
        "hook",
        "run",
        "--to-stdin",
        join(f.directory, "push-input"),
        "pre-push",
      ],
      {
        input,
        env: { ...f.env, HOOK_TEST_PROJECT_EXIT: "21" },
      },
    ).status,
    21,
  );
  f.hook("pre-push", "exit 17");
  writeFileSync(f.log, "");
  assert.equal(
    f.run("git", [
      "hook",
      "run",
      "--to-stdin",
      join(f.directory, "push-input"),
      "pre-push",
    ]).status,
    17,
  );
  assert.equal(f.events(), "original:pre-push\n");
});

test("install is idempotent and uninstall restores inherited or local hooks", (t) => {
  const f = fixture(t);

  f.hook("pre-commit", "exit 0");
  for (const local of [false, true]) {
    if (local) f.git("config", "--local", "core.hooksPath", f.original);
    assert.equal(f.install().status, 0);
    const path = f.git("config", "--get", "core.hooksPath");
    const state = readFileSync(join(path, "state.json"), "utf8");

    assert.equal(f.install().status, 0);
    assert.equal(readFileSync(join(path, "state.json"), "utf8"), state);
    assert.equal(f.run("git", ["hook", "run", "pre-commit"]).status, 0);
    assert.equal(f.install({ args: ["--uninstall"] }).status, 0);
    assert.equal(f.git("config", "--get", "core.hooksPath"), f.original);
    assert.equal(
      f.run("git", ["config", "--local", "--get", "core.hooksPath"]).status,
      local ? 0 : 1,
    );
  }
});

test("linked worktrees share installation and run checks in the active worktree", (t) => {
  const f = fixture(t);
  const linked = join(f.directory, "linked worktree");

  f.hook("pre-commit", "exit 0");
  f.git("worktree", "add", "-b", "linked", linked);
  assert.equal(f.install().status, 0);
  assert.equal(
    f.run(process.execPath, [join(linked, "scripts/git-hooks/install.mjs")], {
      cwd: linked,
    }).status,
    0,
  );
  assert.equal(
    f.run("git", ["hook", "run", "pre-commit"], { cwd: linked }).status,
    0,
  );
  assert.equal(f.events(), "original:pre-commit\nproject:check:staged\n");
  assert.equal(f.install({ args: ["--uninstall"] }).status, 0);
  assert.equal(
    f
      .run("git", ["config", "--get", "core.hooksPath"], { cwd: linked })
      .stdout.trim(),
    f.original,
  );
});

test("CI, explicit opt-out and source archives leave Git configuration alone", (t) => {
  const f = fixture(t);

  for (const extra of [{ CI: "true" }, { SKIP_PROJECT_HOOKS: "1" }]) {
    assert.equal(
      f.install({ spawn: { env: { ...f.env, ...extra } } }).status,
      0,
    );
    assert.equal(f.git("config", "--get", "core.hooksPath"), f.original);
  }

  assert.equal(f.install({ spawn: { cwd: f.directory } }).status, 0);
  assert.equal(f.git("config", "--get", "core.hooksPath"), f.original);
});

test("an explicit worktree override is reported without changing either config", (t) => {
  const f = fixture(t);

  f.git("config", "extensions.worktreeConfig", "true");
  f.git("config", "--worktree", "core.hooksPath", f.original);
  const result = f.install();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /config.worktree override/);
  assert.equal(f.git("config", "--get", "core.hooksPath"), f.original);
  assert.equal(
    f.run("git", ["config", "--local", "--get", "core.hooksPath"]).status,
    1,
  );
});
