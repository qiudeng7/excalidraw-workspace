import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

test("proc-receive negotiates before Git closes its input", async (t) => {
  const f = fixture(t);
  const protocol = `${f.log}.protocol.mjs`;

  writeFileSync(
    protocol,
    `import assert from "node:assert/strict";
import { readSync, writeSync } from "node:fs";
function readExactly(size) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(0, buffer, offset, size - offset);
    if (!count) throw new Error("Unexpected protocol EOF");
    offset += count;
  }
  return buffer;
}
const size = parseInt(readExactly(4).toString(), 16);
assert.equal(readExactly(size - 4).toString(), "version=1\\0");
assert.equal(readExactly(4).toString(), "0000");
writeSync(1, "000eversion=1\\0" + "0000");
process.stdin.resume();
`,
  );
  f.hook("proc-receive", 'exec node "$HOOK_TEST_LOG.protocol.mjs"');
  assert.equal(f.install().status, 0);
  const child = spawn(
    join(f.git("config", "--get", "core.hooksPath"), "proc-receive"),
    [],
    { cwd: f.root, env: f.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const finished = new Promise((resolve) => child.once("close", resolve));
  const hello = Buffer.from("000eversion=1\0" + "0000");
  let timer;
  let stderr = "";

  child.stderr.on("data", (chunk) => (stderr += chunk));
  const response = new Promise((resolve, reject) => {
    let output = Buffer.alloc(0);

    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      output = Buffer.concat([output, chunk]);
      if (output.length >= hello.length) resolve(output);
    });
    timer = setTimeout(
      () => reject(new Error(`No protocol response before EOF: ${stderr}`)),
      5000,
    );
  });

  try {
    child.stdin.write(hello);
    assert.deepEqual(await response, hello);
    child.stdin.end();
    assert.equal(await finished, 0, stderr);
    assert.equal(f.events(), "original:proc-receive\n");
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await finished;
  }
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
