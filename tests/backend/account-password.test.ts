import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { nodeStorage } from "./storage";
import { handleApi } from "./api";
import type { TestDatabase } from "./database";
import * as tables from "../../server/db/schema";
import { eq } from "drizzle-orm";

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "account-password-"));
  const storage = await nodeStorage(directory);
  const request = async (
    path: string,
    method = "GET",
    data?: unknown,
    cookie?: string,
    origin = "https://demo.test",
    owner?: string,
    database = storage.database,
  ) => {
    const pending: Promise<unknown>[] = [];
    const response = await handleApi(
      new Request(`https://demo.test/api${path}`, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Requested-With": "excalidraw-demo",
          ...(cookie ? { Cookie: cookie } : {}),
          ...(owner ? { "X-Account-Owner": owner } : {}),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      {
        ...storage,
        database,
        publicOrigin: "https://demo.test",
        waitUntil: (p) => pending.push(p),
      },
    );

    await Promise.all(pending);

    return {
      status: response.status,
      body: (await response.json()) as any,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  };

  return {
    storage,
    request,
    async close() {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const original = "Original-password-2026!";
const next = "Updated-password-2026!";

/** Stop the actual session write, after the handler has accepted credentials. */
function pauseSessionInsert(database: TestDatabase, afterInsert = false) {
  const reached = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const hold = (query: any): any =>
    new Proxy(query, {
      get(target, key) {
        if (key === "then")
          return async (resolve: any, reject: any) => {
            try {
              const result = afterInsert ? await target : undefined;

              reached.resolve();
              await resume.promise;

              return afterInsert
                ? resolve(result)
                : target.then(resolve, reject);
            } catch (error) {
              reached.reject(error);

              return reject(error);
            }
          };

        const value = Reflect.get(target, key);

        if (["values", "select", "returning"].includes(String(key)))
          return (...args: any[]) => hold(value.apply(target, args));

        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  return {
    async reached() {
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          reached.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Session INSERT barrier timed out")),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    resume: () => resume.resolve(),
    database: new Proxy(database, {
      get(target, key) {
        if (key === "insert")
          return (table: Parameters<TestDatabase["insert"]>[0]) => {
            const builder = target.insert(table);

            return table === tables.sessions ? hold(builder) : builder;
          };

        const value = Reflect.get(target, key);

        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

for (const afterInsert of [false, true])
  for (const entry of ["login", "setup", "register"] as const)
    test(
      `${entry}: password change ${afterInsert ? "after" : "before"} session INSERT invalidates delayed authentication`,
      { timeout: 10000 },
      async () => {
        const f = await fixture();
        const barrier = pauseSessionInsert(f.storage.database, afterInsert);
        let pending: ReturnType<typeof f.request> | undefined;

        try {
          if (entry !== "setup")
            assert.equal(
              (
                await f.request("/setup", "POST", {
                  email: "admin@example.test",
                  password: original,
                })
              ).status,
              200,
            );
          const email =
            entry === "login" ? "admin@example.test" : "alice@example.test";

          pending = f.request(
            `/${entry}`,
            "POST",
            { email, password: original },
            undefined,
            "https://demo.test",
            undefined,
            barrier.database,
          );
          // No sleep or scheduling guess: the session INSERT is waiting here.
          await barrier.reached();
          const current = await f.request("/login", "POST", {
            email,
            password: original,
          });

          assert.equal(current.status, 200);
          const changed = await f.request(
            "/account/password",
            "PUT",
            { currentPassword: original, newPassword: next },
            current.cookie,
          );

          assert.equal(changed.status, 200);
          barrier.resume();
          const stale = await pending;

          if (afterInsert) {
            assert.equal(stale.status, 200);
            assert.ok(
              stale.cookie,
              "a delayed response may still issue its cookie",
            );
            assert.equal(
              (await f.request("/session", "GET", undefined, stale.cookie)).body
                .user,
              null,
              "the cookie for the already inserted session must be revoked",
            );
          } else {
            assert.equal(stale.status, 401);
            assert.equal(stale.body.error.code, "INVALID_CREDENTIALS");
            assert.equal(stale.cookie, undefined);
          }

          assert.equal(
            (await f.request("/session", "GET", undefined, current.cookie)).body
              .user.id,
            current.body.user.id,
          );
          const sessions = await f.storage.database
            .select()
            .from(tables.sessions)
            .where(eq(tables.sessions.userId, current.body.user.id));

          assert.equal(
            sessions.length,
            1,
            "only the current session survives the password change",
          );
          assert.equal(
            (await f.request("/login", "POST", { email, password: original }))
              .status,
            401,
          );
          assert.equal(
            (await f.request("/login", "POST", { email, password: next }))
              .status,
            200,
          );
        } finally {
          barrier.resume();
          try {
            await pending;
          } finally {
            await f.close();
          }
        }
      },
    );

test("password change verifies the original password, preserves the current session and revokes only other sessions of the same user", async () => {
  const f = await fixture();
  const { request } = f;

  try {
    const alice = await request("/setup", "POST", {
      email: "alice@example.test",
      password: original,
    });
    const otherAlice = await request("/login", "POST", {
      email: "alice@example.test",
      password: original,
    });
    const bob = await request("/register", "POST", {
      email: "bob@example.test",
      password: original,
    });
    const credentials = { currentPassword: original, newPassword: next };

    assert.equal(alice.status, 200);
    assert.equal(otherAlice.status, 200);
    assert.equal(bob.status, 200);
    const stalePage = await request(
      "/account/password",
      "PUT",
      credentials,
      bob.cookie,
      "https://demo.test",
      alice.body.user.id,
    );

    assert.equal(stalePage.status, 401);
    assert.equal(stalePage.body.error.code, "SESSION_CHANGED");
    assert.equal(
      (await request("/account/password", "PUT", credentials)).status,
      401,
    );
    assert.equal(
      (await request("/account/password", "GET", undefined, alice.cookie))
        .status,
      405,
    );
    assert.equal(
      (
        await request(
          "/account/password",
          "PUT",
          credentials,
          alice.cookie,
          "https://other.test",
        )
      ).status,
      403,
    );
    for (const [data, code] of [
      [
        { ...credentials, currentPassword: "wrong-original-password" },
        "INVALID_CURRENT_PASSWORD",
      ],
      [{ ...credentials, currentPassword: "" }, "INVALID_CURRENT_PASSWORD"],
      [{ ...credentials, newPassword: "short" }, "INVALID_PASSWORD"],
      [{ ...credentials, newPassword: original }, "PASSWORD_UNCHANGED"],
    ] as const) {
      const failed = await request(
        "/account/password",
        "PUT",
        data,
        alice.cookie,
      );

      assert.equal(failed.body.error.code, code);
      assert.equal(
        (await request("/session", "GET", undefined, otherAlice.cookie)).body
          .user.id,
        alice.body.user.id,
      );
    }

    const before = await f.storage.queries.userByEmail("alice@example.test");
    const updated = await request(
      "/account/password",
      "PUT",
      { ...credentials, userId: bob.body.user.id },
      alice.cookie,
    );

    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body, { updated: true });
    assert.equal(
      (await request("/session", "GET", undefined, alice.cookie)).body.user.id,
      alice.body.user.id,
    );
    assert.equal(
      (await request("/session", "GET", undefined, otherAlice.cookie)).body
        .user,
      null,
    );
    assert.equal(
      (await request("/session", "GET", undefined, bob.cookie)).body.user.id,
      bob.body.user.id,
    );
    assert.equal(
      (
        await request("/login", "POST", {
          email: "alice@example.test",
          password: original,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request("/login", "POST", {
          email: "alice@example.test",
          password: next,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/login", "POST", {
          email: "bob@example.test",
          password: original,
        })
      ).status,
      200,
    );
    const after = await f.storage.queries.userByEmail("alice@example.test");

    assert.notEqual(after!.passwordHash, before!.passwordHash);
    assert.notEqual(after!.passwordHash, next);
  } finally {
    await f.close();
  }
});

test("concurrent password changes cannot both replace the same verified password", async () => {
  const f = await fixture();

  try {
    const account = await f.request("/setup", "POST", {
      email: "alice@example.test",
      password: original,
    });
    const passwords = [next, "Another-password-2026!"];
    const results = await Promise.all(
      passwords.map((newPassword) =>
        f.request(
          "/account/password",
          "PUT",
          { currentPassword: original, newPassword },
          account.cookie,
        ),
      ),
    );

    assert.equal(results.filter((result) => result.status === 200).length, 1);
    assert.ok(
      results.some((result) => result.status === 403 || result.status === 409),
    );
    const winner =
      passwords[results.findIndex((result) => result.status === 200)];

    assert.equal(
      (
        await f.request("/login", "POST", {
          email: "alice@example.test",
          password: winner,
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.request("/session", "GET", undefined, account.cookie)).body.user
        .id,
      account.body.user.id,
    );
  } finally {
    await f.close();
  }
});

test("password verification attempts are rate limited per account", async () => {
  const f = await fixture();

  try {
    const account = await f.request("/setup", "POST", {
      email: "alice@example.test",
      password: original,
    });

    for (let attempt = 0; attempt < 10; attempt++)
      assert.equal(
        (
          await f.request(
            "/account/password",
            "PUT",
            { currentPassword: "wrong-original-password", newPassword: next },
            account.cookie,
          )
        ).status,
        403,
      );
    assert.equal(
      (
        await f.request(
          "/account/password",
          "PUT",
          { currentPassword: original, newPassword: next },
          account.cookie,
        )
      ).status,
      429,
    );
  } finally {
    await f.close();
  }
});
