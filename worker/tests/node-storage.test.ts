import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { nodeStorage } from "../../server/storage/node";
import { handleApi } from "../../server/services/api";
import { collectOrphans } from "../../server/storage/repository";
import { clientIp, publicOrigin } from "../../server/services/security";
test("SQLite service preserves sessions, image snapshots and revisions across restarts", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "workspace-storage-"));
  let storage = await nodeStorage(directory);
  const request = async (
    path: string,
    method = "GET",
    data?: unknown,
    cookie?: string,
    origin = "https://demo.test",
  ) => {
    const pending: Promise<unknown>[] = [];
    const req = new Request(`http://internal/api${path}`, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Requested-With": "excalidraw-demo",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const response = await handleApi(req, {
      ...storage,
      publicOrigin: "https://demo.test",
      clientIp: "192.0.2.7",
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    return {
      status: response.status,
      body: (await response.json()) as any,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
      header: response.headers.get("set-cookie"),
    };
  };
  try {
    assert.equal((await request("/bootstrap")).body.needsSetup, true);
    const setups = await Promise.all(
      ["admin1", "admin2"].map((email) =>
        request("/setup", "POST", {
          email: `${email}@example.com`,
          password: "strong-password-123",
        }),
      ),
    );
    assert.deepEqual(
      setups.map((response) => response.status).sort(),
      [200, 409],
    );
    const admin = setups.find((response) => response.status === 200)!;
    assert.match(admin.header!, /; Secure/);
    const alice = await request("/register", "POST", {
      email: "alice@example.com",
      password: "strong-password-123",
    });
    const bob = await request("/register", "POST", {
      email: "bob@example.com",
      password: "strong-password-123",
    });
    assert.equal(alice.status, 200);
    assert.equal(bob.status, 200);
    const workspace = (
      await request("/workspaces", "GET", undefined, alice.cookie)
    ).body.workspaces[0];
    const canvas = (
      await request(
        `/workspaces/${workspace.id}/canvases`,
        "GET",
        undefined,
        alice.cookie,
      )
    ).body.canvases[0];
    assert.equal(
      (await request(`/canvases/${canvas.id}`, "GET", undefined, bob.cookie))
        .status,
      404,
    );
    const scene = {
      elements: [{ id: "image-a", type: "image" }],
      appState: {},
      files: { image: { dataURL: "data:image/png;base64,abcd" } },
    };
    const saves = await Promise.all(
      [1, 2].map(() =>
        request(
          `/canvases/${canvas.id}`,
          "PUT",
          { scene, revision: 0 },
          alice.cookie,
        ),
      ),
    );
    assert.deepEqual(
      saves.map((response) => response.status).sort(),
      [200, 409],
    );
    const items = [{ id: "library-image", elements: scene.elements }];
    assert.equal(
      (await request("/library", "PUT", { items, revision: 0 }, alice.cookie))
        .status,
      200,
    );
    assert.equal(
      (await request("/library", "GET", undefined, bob.cookie)).body.revision,
      0,
    );
    assert.equal(
      (
        await request(
          "/admin/settings",
          "PATCH",
          { registrationEnabled: false },
          admin.cookie,
          "https://evil.test",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/admin/settings",
          "PATCH",
          { registrationEnabled: false },
          admin.cookie,
        )
      ).status,
      200,
    );
    storage.close();
    storage = await nodeStorage(directory);
    assert.equal(
      (await request("/session", "GET", undefined, alice.cookie)).body.user.id,
      alice.body.user.id,
    );
    assert.equal((await request("/bootstrap")).body.registrationEnabled, false);
    assert.deepEqual(
      (await request(`/canvases/${canvas.id}`, "GET", undefined, alice.cookie))
        .body.canvas.scene,
      scene,
    );
    assert.deepEqual(
      (await request("/library", "GET", undefined, alice.cookie)).body.items,
      items,
    );
    const key = `${alice.body.user.id}/canvas/${canvas.id}/orphan.json`;
    await storage.objects.write(key, {});
    await collectOrphans(storage.repository, storage.objects);
    assert.ok(
      await storage.objects.read(key),
      "fresh uncommitted object must survive GC",
    );
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(resolve(directory, "objects", key), stale, stale);
    await collectOrphans(storage.repository, storage.objects);
    assert.equal(await storage.objects.read(key), null);
    assert.deepEqual(
      (await request(`/canvases/${canvas.id}`, "GET", undefined, alice.cookie))
        .body.canvas.scene,
      scene,
    );
    assert.equal(
      (
        await request(
          `/workspaces/${workspace.id}`,
          "DELETE",
          undefined,
          alice.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request(`/canvases/${canvas.id}`, "GET", undefined, alice.cookie))
        .status,
      404,
    );
    assert.equal(
      (await request("/logout", "POST", undefined, alice.cookie)).status,
      200,
    );
    assert.equal(
      (await request("/session", "GET", undefined, alice.cookie)).body.user,
      null,
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("trusted proxy configuration and origin validation resist forged forwarding headers", () => {
  assert.equal(clientIp("192.0.2.1", "198.51.100.8", "127.0.0.1"), "192.0.2.1");
  assert.equal(
    clientIp(
      "::ffff:127.0.0.1",
      "198.51.100.8, 10.0.0.2",
      "127.0.0.1,10.0.0.2",
    ),
    "198.51.100.8",
  );
  assert.equal(clientIp("127.0.0.1", "invalid IP", "127.0.0.1"), "127.0.0.1");
  assert.throws(() => publicOrigin(undefined, "https://attacker.test", false));
  assert.throws(() =>
    publicOrigin("https://example.test/path", "https://attacker.test", false),
  );
  assert.equal(
    publicOrigin("https://example.test", "http://internal", false),
    "https://example.test",
  );
});
