import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { nodeStorage } from "../../server/storage/node";
import { handleApi, type BackendContext } from "../../server/services/api";
import { digest } from "../../server/services/passwords";
import { createDefaultUserSettings } from "../../shared/contracts";
import type { User, UserSettingsDocument } from "../../shared/contracts";
import { Repository } from "../../server/storage/repository";

test("real request scopes isolate concurrent identities and do not dispose shared storage", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "di-scope-"));
  const storage = await nodeStorage(directory);
  const pending: Promise<unknown>[] = [];
  const context: BackendContext = {
    ...storage,
    publicOrigin: "https://demo.test",
    clientIp: "192.0.2.5",
    waitUntil(promise) {
      pending.push(promise);
    },
  };
  const alice: User = {
    id: crypto.randomUUID(),
    email: "alice@example.com",
    name: "Alice",
    role: "admin",
  };
  const bob: User = {
    id: crypto.randomUUID(),
    email: "bob@example.com",
    name: "Bob",
    role: "user",
  };
  const tokens = ["a".repeat(64), "b".repeat(64)];
  try {
    for (const [index, user] of [alice, bob].entries()) {
      await storage.repository.createAccount(
        user,
        "unused-test-password",
        crypto.randomUUID(),
        crypto.randomUUID(),
        new Date().toISOString(),
      );
      await storage.repository.createSession(
        await digest(tokens[index]!),
        user.id,
        Date.now() + 60000,
      );
    }
    const call = (
      path: string,
      token: string,
      method = "GET",
      value?: unknown,
    ) =>
      handleApi(
        new Request(`https://demo.test/api${path}`, {
          method,
          headers: {
            Cookie: `excalidraw_session=${token}`,
            Origin: context.publicOrigin,
            "X-Requested-With": "excalidraw-demo",
            "Content-Type": "application/json",
          },
          ...(value === undefined ? {} : { body: JSON.stringify(value) }),
        }),
        context,
      );
    const settings = createDefaultUserSettings();
    settings.features.edgeBinding = false;
    const saved = await call("/user-settings", tokens[0]!, "PUT", {
      settings,
      revision: 0,
    });
    assert.equal(saved.status, 200);
    const results = await Promise.all(
      Array.from({ length: 24 }, async (_, index) => {
        const owner = index % 2;
        const session = await call("/session", tokens[owner]!);
        assert.equal(session.status, 200);
        const sessionBody = (await session.json()) as { user: User };
        assert.equal(sessionBody.user.id, [alice, bob][owner]!.id);
        const response = await call("/user-settings", tokens[owner]!);
        assert.equal(response.status, 200);
        const document = (await response.json()) as UserSettingsDocument;
        assert.equal(document.configured, owner === 0);
        assert.equal(document.settings.features.edgeBinding, owner !== 0);
        return response.status;
      }),
    );
    assert.equal(results.length, 24);
    assert.equal((await call("/session", "c".repeat(64))).status, 200);
    assert.equal((await call("/user-settings", "c".repeat(64))).status, 401);
    // A completed request scope does not close the process-owned SQLite connection.
    assert.equal((await storage.repository.userByEmail(bob.email))?.id, bob.id);
    await Promise.all(pending);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("composition failures use the normal HTTP error boundary", async () => {
  const context = {
    get repository() {
      throw new Error("invalid injected storage");
    },
    objects: {},
    publicOrigin: "https://demo.test",
    clientIp: "unknown",
    waitUntil() {},
  } as BackendContext;
  const original = console.error;
  console.error = () => {};
  try {
    const response = await handleApi(
      new Request("https://demo.test/api/bootstrap"),
      context,
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: { code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试" },
    });
  } finally {
    console.error = original;
  }
});

test("repository rejects malformed SQL rows at the storage boundary", async () => {
  const repository = new Repository({
    async query() {
      return {
        rows: [
          {
            id: "user",
            email: "test@example.com",
            name: "Test",
            role: "superuser",
          },
        ],
        changes: 0,
      };
    },
    async transaction() {
      return [];
    },
  });
  await assert.rejects(
    repository.session("hash", Date.now()),
    /Invalid stored role/,
  );
});
