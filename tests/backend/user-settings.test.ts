import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { nodeStorage } from "../../server/storage/node";
import { handleApi } from "../../server/services/api";
import { createDefaultUserSettings } from "../../shared/contracts";

test(`node: isolated user settings, initial CAS, validation and independent revisions`, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "settings-"));
  let close: () => unknown;
  let storage: Pick<
    Awaited<ReturnType<typeof nodeStorage>>,
    "repository" | "objects"
  >;
  const node = await nodeStorage(directory);

  storage = node;
  close = () => node.close();
  const request = async (
    path: string,
    method = "GET",
    data?: unknown,
    cookie?: string,
    owner?: string,
  ) => {
    const pending: Promise<unknown>[] = [];
    const response = await handleApi(
      new Request(`https://demo.test/api${path}`, {
        method,
        headers: {
          Origin: "https://demo.test",
          "Content-Type": "application/json",
          "X-Requested-With": "excalidraw-demo",
          ...(cookie ? { Cookie: cookie } : {}),
          ...(owner
            ? { "X-Settings-Owner": owner, "X-Resource-Owner": owner }
            : {}),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      {
        ...storage,
        publicOrigin: "https://demo.test",
        clientIp: "192.0.2.1",
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

  try {
    const alice = await request("/setup", "POST", {
      email: "alice@example.com",
      password: "strong-password-123",
    });
    const bob = await request("/register", "POST", {
      email: "bob@example.com",
      password: "strong-password-123",
    });

    assert.equal(alice.status, 200);
    assert.equal(bob.status, 200);
    assert.equal((await request("/user-settings")).status, 401);
    const settings = createDefaultUserSettings();
    const original = { settings, revision: 0, configured: false };

    assert.deepEqual(
      (await request("/user-settings", "GET", undefined, alice.cookie)).body,
      original,
    );
    assert.equal(
      (
        await request(
          "/user-settings",
          "PUT",
          { settings, revision: 7 },
          alice.cookie,
        )
      ).status,
      409,
    );
    assert.deepEqual(
      (await request("/user-settings", "GET", undefined, alice.cookie)).body,
      original,
    );
    const saves = await Promise.all(
      [true, false].map((edgeBinding) =>
        request(
          "/user-settings",
          "PUT",
          {
            settings: {
              ...settings,
              features: { ...settings.features, edgeBinding },
            },
            revision: 0,
          },
          alice.cookie,
        ),
      ),
    );

    assert.deepEqual(saves.map((row) => row.status).sort(), [200, 409]);
    const saved = (
      await request("/user-settings", "GET", undefined, alice.cookie)
    ).body;

    assert.equal(saved.revision, 1);
    assert.equal(saved.configured, true);
    assert.deepEqual(saved, saves.find((row) => row.status === 200)!.body);
    for (const invalid of [
      { ...settings, extra: true },
      { ...settings, version: 2 },
      { ...settings, features: { ...settings.features, edgeBinding: 1 } },
      { ...settings, debug: { ...settings.debug, sampling: 3 } },
      {
        ...settings,
        debug: {
          ...settings.debug,
          renderingOptions: {
            ...settings.debug.renderingOptions,
            extra: false,
          },
        },
      },
      { ...settings, features: { edgeBinding: true } },
    ])
      assert.equal(
        (
          await request(
            "/user-settings",
            "PUT",
            { settings: invalid, revision: 1 },
            alice.cookie,
          )
        ).status,
        400,
      );
    assert.deepEqual(
      (await request("/user-settings", "GET", undefined, alice.cookie)).body,
      saved,
    );
    assert.deepEqual(
      (await request("/user-settings", "GET", undefined, bob.cookie)).body,
      original,
    );
    for (const method of ["GET", "PUT"]) {
      const changed = await request(
        "/user-settings",
        method,
        method === "PUT" ? { settings, revision: 0 } : undefined,
        bob.cookie,
        alice.body.user.id,
      );

      assert.equal(changed.status, 401);
      assert.equal(changed.body.error.code, "SESSION_CHANGED");
    }

    assert.deepEqual(
      (await request("/user-settings", "GET", undefined, bob.cookie)).body,
      original,
    );
    assert.deepEqual(
      (await request("/user-settings", "GET", undefined, alice.cookie)).body,
      saved,
    );
    for (const method of ["GET", "PUT"]) {
      const changed = await request(
        "/library",
        method,
        method === "PUT"
          ? { items: [{ id: "wrong-user-payload" }], revision: 0 }
          : undefined,
        bob.cookie,
        alice.body.user.id,
      );

      assert.equal(changed.status, 401);
      assert.equal(changed.body.error.code, "SESSION_CHANGED");
    }

    assert.deepEqual(
      (await request("/library", "GET", undefined, alice.cookie)).body,
      { items: [], revision: 0 },
    );
    assert.deepEqual(
      (await request("/library", "GET", undefined, bob.cookie)).body,
      { items: [], revision: 0 },
    );
    const next = structuredClone(saved.settings);

    next.debug.sampling = 2;
    next.debug.renderingOptions.directText = true;
    assert.equal(
      (
        await request(
          "/user-settings",
          "PUT",
          { settings: next, revision: 1 },
          alice.cookie,
        )
      ).body.revision,
      2,
    );
    assert.equal(
      (
        await request(
          "/user-settings",
          "PUT",
          { settings, revision: 1 },
          alice.cookie,
        )
      ).status,
      409,
    );
    assert.equal(
      (await request("/navigation", "GET", undefined, alice.cookie)).body
        .revision,
      0,
    );
    assert.equal(
      (await request("/library", "GET", undefined, alice.cookie)).body.revision,
      0,
    );
    const workspace = (
      await request("/workspaces", "GET", undefined, alice.cookie)
    ).body.workspaces[0];
    const catalog = (
      await request(
        `/workspaces/${workspace.id}/canvases`,
        "GET",
        undefined,
        alice.cookie,
      )
    ).body;

    assert.equal(catalog.catalogRevision, 0);
    assert.equal(catalog.canvases[0].revision, 0);
  } finally {
    await close!();
    await rm(directory, { recursive: true, force: true });
  }
});
