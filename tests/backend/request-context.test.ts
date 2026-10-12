import { test } from "node:test";
import { createApp, defineEventHandler, toWebHandler } from "h3";
import { requestOrigin, requestClientIp } from "../../server/utils/request";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { nodeStorage } from "./storage";
import { handleApi, type ApiFixture } from "./api";
import { digest } from "../../server/utils/passwords";
import { createDefaultUserSettings } from "../../shared/contracts";
import type { User, UserSettingsDocument } from "../../shared/contracts";
import { sql } from "drizzle-orm";
import { withDatabase } from "./database";

test("request events isolate concurrent identities and keep shared storage available", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "request-isolation-"));
  const storage = await nodeStorage(directory);
  const pending: Promise<unknown>[] = [];
  const context: ApiFixture = {
    ...storage,
    publicOrigin: "https://demo.test",
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
      await storage.queries.createAccount(
        user,
        "unused-test-password",
        crypto.randomUUID(),
        crypto.randomUUID(),
        new Date().toISOString(),
      );
      await storage.queries.createSession(
        await digest(tokens[index]!),
        user.id,
        Date.now() + 60000,
        "unused-test-password",
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
    assert.equal(
      storage.statements.filter((query) =>
        query.includes('inner join "sessions"'),
      ).length,
      1,
      "wrapper and handler reuse the request identity",
    );
    storage.statements.length = 0;
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
    assert.equal(
      storage.statements.filter((query) =>
        query.includes('inner join "sessions"'),
      ).length,
      48,
      "each HTTP request resolves its own identity exactly once",
    );
    assert.equal((await call("/session", "c".repeat(64))).status, 200);
    assert.equal((await call("/user-settings", "c".repeat(64))).status, 401);
    // A completed request does not close the process-owned SQLite connection.
    assert.equal((await storage.queries.userByEmail(bob.email))?.id, bob.id);
    await Promise.all(pending);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("platform initialization failures use the normal HTTP error boundary", async () => {
  const context = {
    get database() {
      throw new Error("invalid platform storage");
    },
    storage: {},
    publicOrigin: "https://demo.test",
    waitUntil() {},
  } as ApiFixture;
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

test("SQLite constraints reject invalid stored roles", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "invalid-role-"));
  const storage = await nodeStorage(directory);

  try {
    await assert.rejects(
      storage.database.run(
        sql`INSERT INTO users VALUES('invalid','invalid@example.com','Invalid','superuser','hash','2020')`,
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        /CHECK constraint failed/.test(error.cause.message),
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native request config controls origins and preserves trusted proxy IP rules", async () => {
  async function inspect(
    config: { publicOrigin: string; trustedProxyIps: string },
    peer: string,
    forwarded: string,
    cloudflare = false,
  ) {
    const app = createApp().use(
      defineEventHandler((event) => {
        event.context.nitro = { runtimeConfig: config };
        Object.defineProperty(event.node.req.socket, "remoteAddress", {
          value: peer,
        });
        if (cloudflare)
          event.context.cloudflare = {
            env: { PUBLIC_ORIGIN: "https://legacy.test" },
          };

        return { origin: requestOrigin(event), ip: requestClientIp(event) };
      }),
    );
    const response = await toWebHandler(app)(
      new Request("http://attacker.test/api/check", {
        headers: {
          "x-forwarded-for": forwarded,
          "x-forwarded-host": "forged.test",
          "x-forwarded-proto": "http",
          "cf-connecting-ip": "203.0.113.20",
        },
      }),
    );

    assert.equal(response.status, 200);

    return response.json();
  }

  assert.deepEqual(
    await inspect(
      { publicOrigin: "https://configured.test", trustedProxyIps: "" },
      "192.0.2.1",
      "198.51.100.8",
    ),
    {
      origin: "https://configured.test",
      ip: "192.0.2.1",
    },
  );
  assert.deepEqual(
    await inspect(
      {
        publicOrigin: "https://configured.test",
        trustedProxyIps: "127.0.0.1,127.0.0.2",
      },
      "127.0.0.1",
      "198.51.100.8,127.0.0.2",
    ),
    {
      origin: "https://configured.test",
      ip: "198.51.100.8",
    },
  );
  assert.deepEqual(
    await inspect(
      { publicOrigin: "https://configured.test", trustedProxyIps: "" },
      "192.0.2.1",
      "198.51.100.8",
      true,
    ),
    {
      origin: "https://configured.test",
      ip: "203.0.113.20",
    },
  );
  assert.deepEqual(
    await inspect(
      { publicOrigin: "", trustedProxyIps: "" },
      "192.0.2.1",
      "198.51.100.8",
      true,
    ),
    {
      origin: "https://legacy.test",
      ip: "203.0.113.20",
    },
  );
});
