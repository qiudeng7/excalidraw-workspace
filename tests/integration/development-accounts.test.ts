import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { nodeStorage } from "./support/storage";
import { withDatabase } from "../lib/database";
import { prepareDevelopmentAccounts } from "../../server/utils/development";
import { parseDevelopmentAccounts } from "../../shared/development";
import { verifyPassword } from "../../server/utils/passwords";
import * as tables from "../../server/db/schema";
import { handleApi } from "./support/api";

const accounts = parseDevelopmentAccounts(
  JSON.stringify([
    {
      role: "admin",
      email: "admin@local.test",
      password: "Admin-development-2026!",
      name: "管理员",
    },
    {
      role: "user",
      email: "user@local.test",
      password: "User-development-2026!",
      name: "用户",
    },
  ]),
);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "development-accounts-"));
  const storage = await nodeStorage(directory);

  return {
    ...storage,
    seed: (value = accounts) =>
      withDatabase(storage.database, () => prepareDevelopmentAccounts(value)),
    async close() {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("development seeds preserve documents and sessions on repeated starts, synchronize changed credentials, and ignore registration settings", async () => {
  const f = await fixture();

  try {
    await f.queries.setRegistration(false);
    await Promise.all([f.seed(), f.seed()]);
    const before = await f.database.select().from(tables.users);
    const admin = before.find((user) => user.role === "admin")!;

    assert.notEqual(admin.passwordHash, accounts[0].password);
    assert.ok(await verifyPassword(accounts[0].password, admin.passwordHash));
    assert.equal((await f.database.select().from(tables.workspaces)).length, 2);
    await f.database.insert(tables.sessions).values({
      tokenHash: "session",
      userId: admin.id,
      expiresAt: Date.now() + 100000,
    });
    const canvas = (await f.database.select().from(tables.canvases))[0];

    await f.database
      .update(tables.canvases)
      .set({ name: "保留画布" })
      .where(eq(tables.canvases.id, canvas.id));
    await f.seed();
    assert.deepEqual(await f.database.select().from(tables.users), before);
    assert.equal((await f.database.select().from(tables.sessions)).length, 1);
    const changed = accounts.map((account) =>
      account.role === "admin"
        ? {
            ...account,
            email: "changed@local.test",
            password: "Updated-development-2026!",
          }
        : account,
    );

    await f.seed(changed);
    const after = (await f.database.select().from(tables.users)).find(
      (user) => user.id === admin.id,
    )!;

    assert.equal(after.email, changed[0].email);
    assert.ok(await verifyPassword(changed[0].password, after.passwordHash));
    assert.equal((await f.database.select().from(tables.sessions)).length, 0);
    assert.equal((await f.database.select().from(tables.workspaces)).length, 2);
    assert.ok(
      (await f.database.select().from(tables.canvases)).some(
        (row) => row.id === canvas.id && row.name === "保留画布",
      ),
    );
    assert.equal((await f.queries.registration())?.registrationEnabled, 0);
  } finally {
    await f.close();
  }
});

test("an existing unmanaged administrator or conflicting ordinary email aborts every development write", async () => {
  for (const role of ["admin", "user"] as const) {
    const f = await fixture();

    try {
      await f.database.insert(tables.users).values({
        id: "real-user",
        email: role === "admin" ? "existing@local.test" : accounts[1].email,
        role,
        name: "已有用户",
        passwordHash: "untouched",
        createdAt: new Date().toISOString(),
      });
      await assert.rejects(f.seed(), /已有账号冲突/);
      const rows = await f.database.select().from(tables.users);

      assert.equal(rows.length, 1);
      assert.equal(rows[0].passwordHash, "untouched");
      assert.equal(
        (await f.database.select().from(tables.workspaces)).length,
        0,
      );
    } finally {
      await f.close();
    }
  }
});

test("ordinary bootstrap and first setup have no development credentials or implicit accounts", async () => {
  const f = await fixture();

  try {
    const response = await handleApi(
      new Request("https://demo.test/api/bootstrap"),
      { ...f, publicOrigin: "https://demo.test", waitUntil() {} },
    );
    const bootstrap = await response.json();

    assert.deepEqual(bootstrap, {
      needsSetup: true,
      registrationEnabled: true,
      emailVerification: false,
    });
    assert.equal((await f.database.select().from(tables.users)).length, 0);
    const prepare = await handleApi(
      new Request("https://demo.test/api/development/prepare", {
        method: "POST",
        headers: {
          Origin: "https://demo.test",
          "X-Requested-With": "excalidraw-demo",
        },
      }),
      { ...f, publicOrigin: "https://demo.test", waitUntil() {} },
    );

    assert.equal(prepare.status, 404);
  } finally {
    await f.close();
  }
});
