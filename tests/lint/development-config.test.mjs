import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { developmentAccounts } from "../../scripts/dev/accounts.mjs";

test("development configuration uses one validated source with environment precedence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dev-configuration-"));
  const path = join(directory, ".env.development.local");

  try {
    const defaults = await developmentAccounts(path, {});

    assert.deepEqual(
      defaults.map((entry) => entry.role),
      ["admin", "user"],
    );
    await writeFile(
      path,
      'DEV_ADMIN_EMAIL=" CHANGED@LOCAL.TEST "\nDEV_ADMIN_PASSWORD="A-file-password-2026!"\nDEV_USER_PASSWORD="An-other-password-2026!"\n',
    );
    const configured = await developmentAccounts(path, {
      DEV_ADMIN_PASSWORD: "An-environment-password-2026!",
    });

    assert.equal(configured[0].email, "changed@local.test");
    assert.equal(configured[0].password, "An-environment-password-2026!");
    assert.equal(configured[1].password, "An-other-password-2026!");
    await assert.rejects(
      developmentAccounts(path, { DEV_ADMIN_PASSWORD: "short" }),
      /配置无效/,
    );
    await assert.rejects(
      developmentAccounts(path, { DEV_USER_EMAIL: "changed@local.test" }),
      /不同邮箱/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
