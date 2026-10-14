import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeStorage } from "./support/storage";
import { handleApi } from "./support/api";
import { withDatabase } from "../lib/database";
import { withBlob } from "../lib/blobs";
import { nodeCommand } from "../../server/collaboration/node";
import type { CanvasView } from "../../shared/collaboration/types";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "collaboration-api-"));
  const storage = await nodeStorage(directory);
  const origin = "https://collaboration.test";
  const request = (
    path: string,
    method = "GET",
    value?: unknown,
    cookie?: string,
    token?: string,
  ) =>
    handleApi(
      new Request(`${origin}/api${path}`, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Requested-With": "excalidraw-demo",
          ...(cookie ? { Cookie: cookie } : {}),
          ...(token ? { "X-Canvas-Access": token } : {}),
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }),
      {
        database: storage.database,
        blob: storage.blob,
        publicOrigin: origin,
        waitUntil: (promise) => {
          pending.push(promise);
        },
      },
    );
  const pending: Promise<unknown>[] = [];
  const setup = await request("/setup", "POST", {
    email: "collaboration-owner@example.test",
    password: "CollaborationPassword123!",
  });

  assert.equal(setup.status, 200, JSON.stringify(await setup.clone().json()));
  const owner = (await setup.json()).user;
  const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const workspaces = await (
    await request("/workspaces", "GET", undefined, cookie)
  ).json();
  const catalog = await (
    await request(
      `/workspaces/${workspaces.workspaces[0].id}/canvases`,
      "GET",
      undefined,
      cookie,
    )
  ).json();
  const id = catalog.canvases[0].id;
  const call = (
    path: string,
    method = "GET",
    value?: unknown,
    actor: string | null = cookie,
    token?: string,
  ) =>
    request(
      `/canvases/${id}/collaboration/${path}`,
      method,
      value,
      actor ?? undefined,
      token,
    );
  const update = async (
    client: string,
    opId: string,
    seq: number,
    elements: unknown[],
    baseSeq = 0,
  ) =>
    call("update", "POST", {
      protocolVersion: 1,
      epoch: view.epoch,
      clientId: client,
      clientSeq: seq,
      opId,
      baseSeq,
      elements,
    });
  const view: CanvasView = await (await call("view")).json();

  assert.ok(view.epoch, JSON.stringify(view));

  return {
    storage,
    request,
    cookie,
    owner,
    id,
    call,
    update,
    view,
    async close() {
      await Promise.all(pending);
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const element = (id: string, extra = {}) => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  angle: 0,
  version: 1,
  versionNonce: 42,
  index: "a0",
  isDeleted: false,
  ...extra,
});

test("authoritative Node room survives fresh reads, merges simultaneous stale-base operations, and rejects legacy writers", async () => {
  const f = await fixture();

  try {
    const responses = await Promise.all([
      f.update("one", "one", 1, [element("a")]),
      f.update("two", "two", 1, [element("b")]),
    ]);

    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    const current = await (await f.call("view")).json();

    assert.equal(current.seq, 2);
    assert.deepEqual(
      current.scene.elements.map((value: any) => value.id),
      ["a", "b"],
    );
    const retry = await f.update("one", "one", 1, [element("a")]);

    assert.equal(retry.status, 200);
    assert.equal((await (await f.call("view")).json()).seq, 2);
    const oldPut = await f.request(
      `/canvases/${f.id}`,
      "PUT",
      { revision: 0, scene: { elements: [], appState: {}, files: {} } },
      f.cookie,
    );

    assert.equal(oldPut.status, 409);
    assert.equal((await oldPut.json()).error.code, "COLLAB_PROTOCOL_REQUIRED");
    const persisted = (await withDatabase(f.storage.database, () =>
      nodeCommand(
        f.id,
        { userId: f.owner.id, name: "Owner" },
        { type: "view" },
      ),
    )) as CanvasView;

    assert.equal(persisted.seq, 2);
    const privateRead = await f.request(
      `/canvases/${f.id}`,
      "GET",
      undefined,
      f.cookie,
    );

    assert.equal((await privateRead.json()).canvas.scene.elements.length, 2);
  } finally {
    await f.close();
  }
});

test("anonymous modes cannot be upgraded and revoked shares stop reads/ticket joins", async () => {
  const f = await fixture();

  try {
    await f.update("owner", "first", 1, [element("first")]);
    assert.equal(
      (await f.call("versions", "POST", { id: "version-1", label: "First" }))
        .status,
      200,
    );
    const tokens: Record<string, string> = {};

    for (const viewMode of ["live", "latest", "fixed"]) {
      const response = await f.call("links", "POST", {
        role: "viewer",
        viewMode,
        requireLogin: false,
        ...(viewMode === "fixed" ? { snapshotId: "version-1" } : {}),
      });
      const link = await response.json();
      const exchanged = await f.call(
        "exchange",
        "POST",
        { secret: link.path.split("#")[1] },
        null,
      );

      tokens[viewMode] = (await exchanged.json()).token;
    }

    await f.update("owner", "second", 2, [element("second")], 1);
    for (const viewMode of ["live", "latest", "fixed"]) {
      const response = await f.call(
        "view?viewMode=live&snapshotId=other",
        "GET",
        undefined,
        null,
        tokens[viewMode],
      );
      const result = await response.json();

      assert.equal(result.access.viewMode, viewMode);
      assert.equal(result.scene.elements.length, viewMode === "fixed" ? 1 : 2);
      assert.equal(
        (await f.call("ticket", "POST", {}, null, tokens[viewMode])).status,
        viewMode === "live" ? 200 : 403,
      );
      assert.equal(
        (await f.call("manage", "GET", undefined, null, tokens[viewMode]))
          .status,
        401,
      );
      const operation = {
        protocolVersion: 1,
        epoch: f.view.epoch,
        clientId: "viewer",
        clientSeq: 1,
        opId: `viewer-${viewMode}`,
        baseSeq: 2,
        elements: [element("attack")],
      };

      assert.equal(
        (await f.call("update", "POST", operation, null, tokens[viewMode]))
          .status,
        403,
      );
    }

    const manage = await (await f.call("manage")).json();

    for (const link of manage.links)
      assert.equal(
        (await f.call("links", "DELETE", { id: link.id })).status,
        200,
      );
    assert.equal(
      (await f.call("view", "GET", undefined, null, tokens.latest)).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("fixed image references survive live deletion, legacy orphan cleanup and room reload", async () => {
  const f = await fixture();

  try {
    const file = {
      id: "image",
      mimeType: "image/png",
      created: 1,
      dataURL: "data:image/png;base64,aGVsbG8=",
    };

    assert.equal((await f.call("assets", "POST", file)).status, 200);
    assert.equal(
      (
        await f.update("owner", "image", 1, [
          element("image-element", { type: "image", fileId: "image" }),
        ])
      ).status,
      200,
    );
    await f.call("versions", "POST", { id: "image-version", label: "Image" });
    const link = await (
      await f.call("links", "POST", {
        role: "viewer",
        viewMode: "fixed",
        snapshotId: "image-version",
        requireLogin: false,
      })
    ).json();
    const token = (
      await (
        await f.call(
          "exchange",
          "POST",
          { secret: link.path.split("#")[1] },
          null,
        )
      ).json()
    ).token;

    await f.update(
      "owner",
      "delete-image",
      2,
      [
        element("image-element", {
          type: "image",
          fileId: "image",
          version: 2,
          isDeleted: true,
        }),
      ],
      1,
    );
    await f.storage.collectOrphans();
    const fixed = await (
      await f.call("view", "GET", undefined, null, token)
    ).json();

    assert.equal(fixed.scene.files.image.dataURL, file.dataURL);
    assert.equal(fixed.scene.elements[0].isDeleted, false);
    await f.call("versions", "DELETE", { id: "image-version" });
    assert.equal(
      (await f.call("view", "GET", undefined, null, token)).status,
      410,
    );
  } finally {
    await f.close();
  }
});

test("member directory projection recovers after its database write fails, without rolling back permissions", async () => {
  const f = await fixture();

  try {
    const registered = await f.request("/register", "POST", {
      email: "invited@example.test",
      name: "Invited",
      password: "InvitedPassword123!",
    });
    const invited = await registered.json();
    const cookie = registered.headers.get("set-cookie")!.split(";")[0]!;
    const database = f.storage.database;
    const client = database.$client;
    let failed = false;

    f.storage.database = new Proxy(database, {
      get(target, key) {
        if (key === "$client")
          return new Proxy(client, {
            get(inner, property) {
              if (property === "batch")
                return (...args: Parameters<typeof client.batch>) => {
                  if (!failed) {
                    failed = true;

                    return Promise.reject(new Error("Projection unavailable"));
                  }

                  return client.batch(...args);
                };

              const value = Reflect.get(inner, property);

              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        const value = Reflect.get(target, key);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await f.call("members", "POST", {
      email: "invited@example.test",
      role: "editor",
    });

    assert.equal(response.status, 500);
    f.storage.database = database;
    assert.equal((await f.call("view", "GET", undefined, cookie)).status, 200);
    const { repairNodeProjections } =
      await import("../../server/collaboration/node-projection");

    await withDatabase(database, repairNodeProjections);
    const shared = await (
      await f.request("/shared-canvases", "GET", undefined, cookie)
    ).json();

    assert.deepEqual(
      shared.canvases.map((item: any) => item.id),
      [f.id],
    );
    assert.equal(
      (await f.call("members", "DELETE", { userId: invited.user.id })).status,
      200,
    );
    assert.equal((await f.call("view", "GET", undefined, cookie)).status, 403);
    assert.deepEqual(
      (
        await (
          await f.request("/shared-canvases", "GET", undefined, cookie)
        ).json()
      ).canvases,
      [],
    );
  } finally {
    await f.close();
  }
});

test("an in-flight legacy PUT cannot publish after room migration freezes the source revision", async () => {
  const f = await fixture();
  let release = () => {};

  try {
    const spaces = (
      await (await f.request("/workspaces", "GET", undefined, f.cookie)).json()
    ).workspaces;
    const created = await f.request(
      `/workspaces/${spaces[0].id}/canvases`,
      "POST",
      { name: "Legacy", catalogRevision: 0 },
      f.cookie,
    );
    const id = (await created.json()).canvas.id;
    const blob = f.storage.blob;
    let blocked = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    f.storage.blob = new Proxy(blob, {
      get(target, key) {
        if (key === "put")
          return async (...args: Parameters<typeof target.put>) => {
            if (args[0].includes(`/canvas/${id}/`)) {
              blocked = true;
              await gate;
            }

            return target.put(...args);
          };

        const value = Reflect.get(target, key);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const saving = f.request(
      `/canvases/${id}`,
      "PUT",
      {
        revision: 0,
        scene: { elements: [element("late")], appState: {}, files: {} },
      },
      f.cookie,
    );
    const { setImmediate } = await import("node:timers/promises");

    while (!blocked) await setImmediate();
    const migrated = await f.request(
      `/canvases/${id}/collaboration/view`,
      "GET",
      undefined,
      f.cookie,
    );

    assert.equal(migrated.status, 200);
    release();
    assert.equal((await saving).status, 409);
    const result = await (
      await f.request(
        `/canvases/${id}/collaboration/view`,
        "GET",
        undefined,
        f.cookie,
      )
    ).json();

    assert.equal(result.scene.elements.length, 0);
  } finally {
    release();
    await f.close();
  }
});

test("purging a workspace retries durable room tombstones and prevents old clients from recreating its canvases", async () => {
  const f = await fixture();

  try {
    const spaces = (
      await (await f.request("/workspaces", "GET", undefined, f.cookie)).json()
    ).workspaces;

    assert.equal(
      (
        await f.request(
          `/workspaces/${spaces[0].id}`,
          "DELETE",
          undefined,
          f.cookie,
        )
      ).status,
      200,
    );

    // Simulate an interruption after room deletion but before catalog deletion.
    await withDatabase(f.storage.database, () =>
      nodeCommand(
        f.id,
        { userId: f.owner.id, name: "Owner" },
        { type: "delete" },
      ),
    );
    const response = await f.request(
      `/recycle-bin/workspace/${spaces[0].id}`,
      "DELETE",
      { confirm: true },
      f.cookie,
    );

    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    assert.equal((await f.call("view")).status, 404);
    await assert.rejects(
      withDatabase(f.storage.database, () =>
        nodeCommand(
          f.id,
          { userId: f.owner.id, name: "Owner" },
          { type: "view" },
        ),
      ),
      (error: any) => error.code === "CANVAS_DELETED",
    );
    assert.equal(
      (await f.update("old", "late", 1, [element("late")])).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("room backup excludes connection credentials; restore uses a new epoch and refuses concurrent changes", async () => {
  const f = await fixture();

  try {
    await f.update("owner", "before-backup", 1, [element("original")]);
    await f.call("ticket", "POST", {});
    const backup = await (await f.call("backup")).json();

    assert.equal(backup.format, "excalidraw-room-v1");
    assert.deepEqual(backup.state.tickets, {});
    assert.deepEqual(backup.state.capabilities, {});
    const viewer = await (
      await f.call("links", "POST", {
        role: "viewer",
        viewMode: "latest",
        requireLogin: false,
      })
    ).json();
    const secret = viewer.path.split("#")[1];
    const token = (
      await (await f.call("exchange", "POST", { secret }, null)).json()
    ).token;

    assert.equal(
      (await f.call("backup", "GET", undefined, null, token)).status,
      401,
    );
    await f.update(
      "owner",
      "after-backup",
      2,
      [element("second", { index: "a1" })],
      1,
    );
    const stale = await f.call("restore", "POST", {
      backup,
      expectedEpoch: backup.state.epoch,
      expectedSeq: backup.state.seq,
      expectedAccessRevision: backup.state.accessRevision,
    });

    assert.equal(stale.status, 409);
    const beforeRestore = await (await f.call("backup")).json();
    const restored = await f.call("restore", "POST", {
      backup,
      expectedEpoch: beforeRestore.state.epoch,
      expectedSeq: beforeRestore.state.seq,
      expectedAccessRevision: beforeRestore.state.accessRevision,
    });

    assert.equal(
      restored.status,
      200,
      JSON.stringify(await restored.clone().json()),
    );
    const current = await (await f.call("view")).json();

    assert.notEqual(current.epoch, backup.state.epoch);
    assert.equal(current.seq, 0);
    assert.deepEqual(
      current.scene.elements.map((item: any) => item.id),
      ["original"],
    );
    assert.equal(
      (await f.update("owner", "late-old-epoch", 3, [element("late")], 2))
        .status,
      409,
    );
    assert.equal(
      (await f.call("view", "GET", undefined, null, token)).status,
      403,
    );
    const wrongOwner = structuredClone(backup);

    wrongOwner.state.ownerId = "someone-else";
    assert.equal(
      (await f.call("restore", "POST", { backup: wrongOwner })).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test("restored fixed versions retain their image objects and room cleanup removes only unreferenced objects", async () => {
  const f = await fixture();

  try {
    const image = {
      id: "image",
      dataURL: "data:image/png;base64,aGVsbG8=",
      mimeType: "image/png",
      created: 1,
    };

    assert.equal((await f.call("assets", "POST", image)).status, 200);
    await f.update("one", "image", 1, [
      element("image-element", { type: "image", fileId: "image" }),
    ]);
    await f.call("versions", "POST", { id: "pinned", label: "Pinned image" });
    const backup = await (await f.call("backup")).json();
    const version = backup.state.versions[0];
    const originalImageKey = backup.state.scene.files.image.objectKey;
    const read = await f.call(
      `backup?object=${encodeURIComponent(originalImageKey)}`,
    );

    assert.equal(read.status, 200);
    const uploaded = await f.call("restore-object", "POST", {
      content: JSON.stringify(await read.json()),
    });
    const restoredImageKey = (await uploaded.json()).key;
    const snapshot = await (
      await f.call(`backup?object=${encodeURIComponent(version.sceneKey)}`)
    ).json();

    snapshot.files.image.objectKey = restoredImageKey;
    version.files.image.objectKey = restoredImageKey;
    backup.state.scene.files.image.objectKey = restoredImageKey;
    version.sceneKey = (
      await (
        await f.call("restore-object", "POST", {
          content: JSON.stringify(snapshot),
        })
      ).json()
    ).key;
    const response = await f.call("restore", "POST", {
      backup,
      expectedEpoch: backup.state.epoch,
      expectedSeq: backup.state.seq,
      expectedAccessRevision: backup.state.accessRevision,
    });

    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    const link = await (
      await f.call("links", "POST", {
        role: "viewer",
        viewMode: "fixed",
        snapshotId: "pinned",
        requireLogin: false,
      })
    ).json();
    const token = (
      await (
        await f.call(
          "exchange",
          "POST",
          { secret: link.path.split("#")[1] },
          null,
        )
      ).json()
    ).token;
    const orphan = `collaboration/${f.id}/restores/orphan.json`;

    await f.storage.blob.put(orphan, "{}");
    const { collectNodeRoomOrphans } =
      await import("../../server/collaboration/node-cleanup");

    await withDatabase(f.storage.database, () =>
      withBlob(f.storage.blob, () =>
        collectNodeRoomOrphans(Date.now() + 2 * 86400000),
      ),
    );
    assert.equal(await f.storage.blob.get(orphan), null);
    assert.equal(await f.storage.blob.get(originalImageKey), null);
    assert.ok(await f.storage.blob.get(restoredImageKey));
    const fixed = await (
      await f.call("view", "GET", undefined, null, token)
    ).json();

    assert.equal(fixed.scene.files.image.dataURL, image.dataURL);
    assert.equal(fixed.name, backup.state.name);
  } finally {
    await f.close();
  }
});
