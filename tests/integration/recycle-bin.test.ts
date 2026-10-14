import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeStorage } from "./support/storage";
import { handleApi } from "./support/api";
import { withDatabase } from "../lib/database";
import { withBlob } from "../lib/blobs";
import {
  canvases,
  collaborationRooms,
  workspaces,
} from "../../server/db/schema";
import {
  collectRecycleBin,
  syncRecycleRooms,
} from "../../server/utils/recycle-bin";
import {
  RECYCLE_RETENTION,
  recycleCanvas,
  recycleWorkspace,
  restoreRecycleEntry,
} from "../../server/db/recycle-bin";
import { collectOrphans } from "../../server/utils/cleanup";
import { collectNodeRoomOrphans } from "../../server/collaboration/node-cleanup";
import { eq } from "drizzle-orm";
import { nodeCommand } from "../../server/collaboration/node";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "recycle-bin-"));
  const storage = await nodeStorage(directory);
  const origin = "https://recycle.test";
  const pending: Promise<unknown>[] = [];
  let cookie = "";
  let blob = storage.blob;
  const request = (
    path: string,
    method = "GET",
    value?: unknown,
    actor = cookie,
    headers: Record<string, string> = {},
  ) =>
    handleApi(
      new Request(`${origin}/api${path}`, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Requested-With": "excalidraw-demo",
          Cookie: actor,
          ...headers,
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }),
      {
        database: storage.database,
        blob,
        publicOrigin: origin,
        waitUntil: (task) => pending.push(task),
      },
    );
  const auth = await request("/setup", "POST", {
    email: "recycle-owner@example.test",
    password: "RecyclePassword123!",
  });

  assert.equal(auth.status, 200);
  cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
  const owner = (await auth.json()).user;
  const spaces = (await (await request("/workspaces")).json()).workspaces;
  const catalog = await (
    await request(`/workspaces/${spaces[0].id}/canvases`)
  ).json();
  const id = catalog.canvases[0].id;
  const context = <T>(action: () => T) =>
    withDatabase(storage.database, () => withBlob(blob, action));

  return {
    ...storage,
    request,
    id,
    owner,
    workspaceId: spaces[0].id,
    context,
    interceptBlob(value: typeof blob) {
      blob = value;
    },
    async close() {
      await Promise.all(pending);
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const scene = {
  elements: [],
  appState: { viewBackgroundColor: "#aabbcc" },
  files: {},
};

const element = (id: string) => ({
  id,
  type: "rectangle",
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  angle: 0,
});

test("recycling retains snapshots, clears navigation, and restores identity with an old-client CAS fence", async () => {
  const f = await fixture();

  try {
    assert.equal(
      (await f.request(`/canvases/${f.id}`, "PUT", { revision: 0, scene }))
        .status,
      200,
    );
    assert.equal(
      (await f.request("/navigation", "PUT", { canvasId: f.id, revision: 0 }))
        .status,
      200,
    );
    const original = (await f.database.select().from(canvases))[0]!;

    assert.equal(
      (await f.request(`/canvases/${f.id}`, "DELETE", { catalogRevision: 0 }))
        .status,
      200,
    );
    assert.equal((await f.request(`/canvases/${f.id}`)).status, 404);
    assert.equal(
      (await f.request(`/canvases/${f.id}`, "PATCH", { name: "bad" })).status,
      404,
    );
    assert.equal(
      (
        await f.request(`/canvases/${f.id}/presence`, "POST", {
          clientId: "client-aaaaaaaaaaaa",
        })
      ).status,
      404,
    );
    assert.equal(
      (await (await f.request(`/workspaces/${f.workspaceId}/canvases`)).json())
        .canvases.length,
      0,
    );
    assert.equal(
      (await (await f.request("/navigation")).json()).lastCanvasId,
      null,
    );
    assert.ok(await f.blob.get(original.objectKey!));
    const entries = (await (await f.request("/recycle-bin")).json()).entries;

    assert.equal(entries[0].id, f.id);
    assert.equal(
      Date.parse(entries[0].expiresAt) - Date.parse(entries[0].deletedAt),
      RECYCLE_RETENTION,
    );
    assert.equal(
      (await f.request(`/recycle-bin/canvas/${f.id}`, "POST", {})).status,
      200,
    );
    const restored = (await (await f.request(`/canvases/${f.id}`)).json())
      .canvas;

    assert.equal(restored.id, original.id);
    assert.equal(restored.name, original.name);
    assert.deepEqual(restored.scene, scene);
    assert.ok(restored.revision > original.revision);
    assert.equal(
      (
        await f.request(`/canvases/${f.id}`, "PUT", {
          revision: original.revision,
          scene: { ...scene, elements: [element("stale")] },
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});

test("workspace recovery preserves independently recycled children and prohibits cross-owner administrator access", async () => {
  const f = await fixture();

  try {
    const second = (
      await (
        await f.request(`/workspaces/${f.workspaceId}/canvases`, "POST", {
          name: "保留画布",
          catalogRevision: 0,
        })
      ).json()
    ).canvas;

    assert.equal(
      (await f.request(`/canvases/${f.id}`, "DELETE", { catalogRevision: 1 }))
        .status,
      200,
    );
    assert.equal(
      (await f.request(`/workspaces/${f.workspaceId}`, "DELETE")).status,
      200,
    );
    assert.deepEqual(
      (await (await f.request("/workspaces")).json()).workspaces,
      [],
    );
    assert.equal(
      (
        await f.request(`/workspaces/${f.workspaceId}`, "PATCH", {
          name: "bad",
        })
      ).status,
      404,
    );
    assert.equal(
      (await f.request(`/recycle-bin/canvas/${f.id}`, "POST", {})).status,
      404,
    );
    assert.deepEqual(
      (await (await f.request("/recycle-bin")).json()).entries.map(
        (entry: any) => entry.kind,
      ),
      ["workspace"],
    );
    assert.equal(
      (await f.request(`/recycle-bin/workspace/${f.workspaceId}`, "POST", {}))
        .status,
      200,
    );
    assert.deepEqual(
      (
        await (await f.request(`/workspaces/${f.workspaceId}/canvases`)).json()
      ).canvases.map((entry: any) => entry.id),
      [second.id],
    );
    assert.equal(
      (await (await f.request("/recycle-bin")).json()).entries[0].id,
      f.id,
    );
    const guest = await f.request("/register", "POST", {
      email: "recycle-guest@example.test",
      password: "RecyclePassword123!",
    });
    const guestCookie = guest.headers.get("set-cookie")!.split(";")[0]!;
    const ownSpaces = (
      await (
        await f.request("/workspaces", "GET", undefined, guestCookie)
      ).json()
    ).workspaces;

    assert.equal(
      (
        await f.request(
          `/workspaces/${ownSpaces[0].id}`,
          "DELETE",
          undefined,
          guestCookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.request(`/recycle-bin/workspace/${ownSpaces[0].id}`, "POST", {}))
        .status,
      404,
    );
    assert.equal(
      (
        await f.request(`/recycle-bin/workspace/${ownSpaces[0].id}`, "DELETE", {
          confirm: true,
        })
      ).status,
      404,
    );
    assert.ok(
      !(await (await f.request("/recycle-bin")).json()).entries.some(
        (entry: any) => entry.id === ownSpaces[0].id,
      ),
    );
  } finally {
    await f.close();
  }
});

test("exactly 30 days cannot be restored before cron; expiry cleanup is idempotent and retains unexpired resources", async () => {
  const f = await fixture();

  try {
    await f.request(`/canvases/${f.id}`, "PUT", { revision: 0, scene });
    const original = (await f.database.select().from(canvases))[0]!;
    const now = Date.now();
    const deletedAt = new Date(now - RECYCLE_RETENTION).toISOString();

    await f.context(() =>
      recycleCanvas(f.id, f.owner.id, f.workspaceId, 0, deletedAt),
    );
    assert.equal(
      await f.context(() =>
        restoreRecycleEntry("canvas", f.id, f.owner.id, now),
      ),
      0,
    );
    assert.deepEqual(
      (await (await f.request("/recycle-bin")).json()).entries,
      [],
    );
    assert.equal(
      (await f.request(`/recycle-bin/canvas/${f.id}`, "POST", {})).status,
      404,
    );
    await f.context(() => collectRecycleBin(undefined, now));
    await f.context(() => collectRecycleBin(undefined, now));
    assert.deepEqual(await f.database.select().from(canvases), []);
    assert.equal(await f.blob.get(original.objectKey!), null);
    assert.equal((await f.database.select().from(workspaces)).length, 1);
  } finally {
    await f.close();
  }
});

test("late snapshot publish cannot write into a recycled or restored canvas", async () => {
  const f = await fixture();
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writing = false;

  try {
    const original = f.blob;

    f.interceptBlob(
      new Proxy(original, {
        get(target, key) {
          if (key === "put")
            return async (...args: Parameters<typeof original.put>) => {
              writing = true;
              await blocker;

              return target.put(...args);
            };

          const value = Reflect.get(target, key);

          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
    const saving = f.request(`/canvases/${f.id}`, "PUT", {
      revision: 0,
      scene: { ...scene, elements: [element("late")] },
    });

    while (!writing)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      (await f.request(`/canvases/${f.id}`, "DELETE", { catalogRevision: 0 }))
        .status,
      200,
    );
    assert.equal(
      (await f.request(`/recycle-bin/canvas/${f.id}`, "POST", {})).status,
      200,
    );
    release();
    assert.equal((await saving).status, 409);
    assert.deepEqual(
      (await (await f.request(`/canvases/${f.id}`)).json()).canvas.scene
        .elements,
      [],
    );
  } finally {
    release();
    await f.close();
  }
});

test("collaboration is suspended without destroying grants, snapshots or images; restore rotates epoch and rejects old operations", async () => {
  const f = await fixture();

  try {
    const initial = await (
      await f.request(`/canvases/${f.id}/collaboration/view`)
    ).json();
    const link = await (
      await f.request(`/canvases/${f.id}/collaboration/links`, "POST", {
        role: "viewer",
        viewMode: "latest",
        requireLogin: false,
        expiresAt: null,
      })
    ).json();
    const prefix = `/canvases/${f.id}/collaboration`;
    const update = {
      protocolVersion: 1,
      epoch: initial.epoch,
      clientId: "owner-aaaaaaaaaaaa",
      opId: "operation-aaaaaaaaaaaa",
      clientSeq: 1,
      baseSeq: 0,
      elements: [element("retained")],
    };

    assert.equal(
      (await f.request(`${prefix}/update`, "POST", update)).status,
      200,
    );
    const before = JSON.parse(
      (await f.database.select().from(collaborationRooms))[0]!.state,
    );

    assert.equal(
      (await f.request(`/canvases/${f.id}`, "DELETE", { catalogRevision: 0 }))
        .status,
      200,
    );
    for (const route of ["view", "access", "manage", "backup"])
      assert.equal((await f.request(`${prefix}/${route}`)).status, 410);
    assert.equal(
      (
        await f.request(`${prefix}/exchange`, "POST", {
          secret: link.path.split("#")[1],
        })
      ).status,
      410,
    );
    assert.equal(
      (await f.request(`${prefix}/update`, "POST", update)).status,
      410,
    );
    const paused = JSON.parse(
      (await f.database.select().from(collaborationRooms))[0]!.state,
    );

    assert.equal(paused.deleted, false);
    assert.deepEqual(paused.scene, before.scene);
    assert.deepEqual(paused.links, before.links);
    assert.equal(
      (await f.request(`/recycle-bin/canvas/${f.id}`, "POST", {})).status,
      200,
    );
    const after = await (await f.request(`${prefix}/view`)).json();

    assert.notEqual(after.epoch, initial.epoch);
    assert.equal(after.seq, 0);
    assert.equal(after.scene.elements[0].id, "retained");
    assert.equal(
      (await f.request(`${prefix}/update`, "POST", update)).status,
      409,
    );
    assert.equal(
      (
        await f.request(`${prefix}/exchange`, "POST", {
          secret: link.path.split("#")[1],
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.request(`/canvases/${f.id}`, "DELETE", { catalogRevision: 2 }))
        .status,
      200,
    );
    assert.equal(
      (await f.request(`/recycle-bin/canvas/${f.id}`, "DELETE", {})).status,
      400,
    );
    assert.equal(
      (
        await f.request(`/recycle-bin/canvas/${f.id}`, "DELETE", {
          confirm: true,
        })
      ).status,
      200,
    );
    const purged = JSON.parse(
      (await f.database.select().from(collaborationRooms))[0]!.state,
    );

    assert.equal(purged.deleted, true);
    assert.deepEqual(purged.scene.elements, []);
    assert.deepEqual(purged.links, []);
    assert.deepEqual(purged.operations, {});
  } finally {
    await f.close();
  }
});

test("recycle synchronization keeps retry intent and stale commands cannot suspend a restored room", async () => {
  const f = await fixture();

  try {
    const original = await (
      await f.request(`/canvases/${f.id}/collaboration/view`)
    ).json();

    await f.context(() => recycleWorkspace(f.workspaceId, f.owner.id));
    const namespace = {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async () => {
          throw new Error("temporary DO outage");
        },
      }),
    };

    await assert.rejects(
      f.context(() => syncRecycleRooms(namespace)),
      /temporary DO outage/,
    );
    assert.equal(
      (await f.database.select().from(canvases))[0]!.recyclePending,
      1,
    );
    await f.context(() =>
      restoreRecycleEntry("workspace", f.workspaceId, f.owner.id),
    );
    assert.equal(
      (await f.request(`/canvases/${f.id}/collaboration/view`)).status,
      503,
    );
    await f.context(() => syncRecycleRooms());
    const active = await (
      await f.request(`/canvases/${f.id}/collaboration/view`)
    ).json();

    assert.notEqual(active.epoch, original.epoch);
    assert.equal(
      (
        await f.request(`/canvases/${f.id}/collaboration/update`, "POST", {
          protocolVersion: 1,
          epoch: original.epoch,
          baseSeq: original.seq,
          clientId: "missing-pause-client",
          clientSeq: 1,
          opId: "missing-pause-stale-operation",
          elements: [],
        })
      ).status,
      409,
    );

    await f.context(() =>
      nodeCommand(
        f.id,
        { userId: f.owner.id, name: "" },
        {
          type: "recycle",
          deletedAt: new Date().toISOString(),
          revision: 1,
          epoch: "stale-epoch",
        },
      ),
    );
    assert.equal(
      (await f.request(`/canvases/${f.id}/collaboration/view`)).status,
      200,
    );
    assert.equal(
      (await (await f.request(`/canvases/${f.id}/collaboration/view`)).json())
        .epoch,
      active.epoch,
    );
    assert.equal(
      (await f.database.select().from(canvases))[0]!.recyclePending,
      0,
    );
  } finally {
    await f.close();
  }
});

test("maintenance before expiry retains legacy snapshots, paused room images and fixed versions under a recycled workspace", async () => {
  const f = await fixture();

  try {
    const picture = {
      id: "retained-image",
      dataURL: "data:image/png;base64,aGVsbG8=",
      mimeType: "image/png",
      created: Date.now(),
    };
    const imageScene = {
      elements: [
        { ...element("image-element"), type: "image", fileId: picture.id },
      ],
      appState: {},
      files: { [picture.id]: picture },
    };

    assert.equal(
      (
        await f.request(`/canvases/${f.id}`, "PUT", {
          revision: 0,
          scene: imageScene,
        })
      ).status,
      200,
    );
    const other = (
      await (
        await f.request(`/workspaces/${f.workspaceId}/canvases`, "POST", {
          name: "旧版图片",
          catalogRevision: 0,
        })
      ).json()
    ).canvas;

    assert.equal(
      (
        await f.request(`/canvases/${other.id}`, "PUT", {
          revision: 0,
          scene: imageScene,
        })
      ).status,
      200,
    );
    const legacy = (await f.database.select().from(canvases)).find(
      (row) => row.id === other.id,
    )!;

    await f.request(`/canvases/${f.id}/collaboration/view`);
    assert.equal(
      (
        await f.request(`/canvases/${f.id}/collaboration/versions`, "POST", {
          id: "fixed-retained",
          label: "保留版本",
        })
      ).status,
      200,
    );
    const link = await (
      await f.request(`/canvases/${f.id}/collaboration/links`, "POST", {
        role: "viewer",
        viewMode: "fixed",
        snapshotId: "fixed-retained",
        requireLogin: false,
        expiresAt: null,
      })
    ).json();
    const capability = await (
      await f.request(
        `/canvases/${f.id}/collaboration/exchange`,
        "POST",
        {
          secret: link.path.split("#")[1],
        },
        "",
      )
    ).json();
    const before = JSON.parse(
      (await f.database.select().from(collaborationRooms))[0]!.state,
    );

    assert.equal(
      (await f.request(`/workspaces/${f.workspaceId}`, "DELETE")).status,
      200,
    );
    await f.context(() => collectOrphans(Date.now() + 2 * 86400000));
    await f.context(() => collectNodeRoomOrphans(Date.now() + 2 * 86400000));
    assert.ok(await f.blob.get(legacy.objectKey!));
    assert.ok(await f.blob.get(before.scene.files[picture.id].objectKey));
    assert.ok(await f.blob.get(before.versions[0].sceneKey));
    assert.equal(
      (await f.request(`/recycle-bin/workspace/${f.workspaceId}`, "POST", {}))
        .status,
      200,
    );
    assert.deepEqual(
      (await (await f.request(`/canvases/${other.id}`)).json()).canvas.scene
        .files,
      imageScene.files,
    );
    const fixed = await f.request(
      `/canvases/${f.id}/collaboration/view`,
      "GET",
      undefined,
      "",
      { "X-Canvas-Access": capability.token },
    );

    assert.equal(fixed.status, 200, JSON.stringify(await fixed.clone().json()));
    const value = await fixed.json();

    assert.equal(value.access.viewMode, "fixed");
    assert.equal(value.scene.files[picture.id].dataURL, picture.dataURL);
    assert.equal(value.scene.elements[0].id, "image-element");
  } finally {
    await f.close();
  }
});

test("an interrupted preparing room can recycle and restore without a permanent pending gate", async () => {
  const f = await fixture();

  try {
    await f.request(`/canvases/${f.id}`, "PUT", { revision: 0, scene });
    await f.database
      .update(canvases)
      .set({
        syncMode: "preparing",
        roomEpoch: "interrupted-migration",
        migrationEpoch: "interrupted-migration",
      })
      .where(eq(canvases.id, f.id));
    assert.equal(
      (await f.request(`/canvases/${f.id}`, "DELETE", { catalogRevision: 0 }))
        .status,
      200,
    );
    assert.equal(
      (await f.request(`/recycle-bin/canvas/${f.id}`, "POST", {})).status,
      200,
    );
    const restored = await f.request(`/canvases/${f.id}/collaboration/view`);

    assert.equal(
      restored.status,
      200,
      JSON.stringify(await restored.clone().json()),
    );
    assert.equal(
      (await restored.json()).scene.appState.viewBackgroundColor,
      "#aabbcc",
    );
    assert.equal(
      (await f.database.select().from(canvases))[0]!.recyclePending,
      0,
    );
  } finally {
    await f.close();
  }
});

test("one failed room never blocks another account's expired legacy cleanup", async () => {
  const f = await fixture();

  try {
    await f.request(`/canvases/${f.id}/collaboration/view`);
    const other = (
      await (
        await f.request(`/workspaces/${f.workspaceId}/canvases`, "POST", {
          name: "待清理",
          catalogRevision: 0,
        })
      ).json()
    ).canvas;

    await f.context(() => recycleCanvas(f.id, f.owner.id, f.workspaceId, 1));
    await f.context(() =>
      recycleCanvas(
        other.id,
        f.owner.id,
        f.workspaceId,
        2,
        new Date(Date.now() - RECYCLE_RETENTION).toISOString(),
      ),
    );
    const namespace = {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async () => {
          throw new Error("bad room");
        },
      }),
    };

    await assert.rejects(
      f.context(() => collectRecycleBin(namespace)),
      AggregateError,
    );
    const remaining = await f.database.select().from(canvases);

    assert.deepEqual(
      remaining.map((row) => row.id),
      [f.id],
    );
    assert.equal(remaining[0]!.recyclePending, 1);
  } finally {
    await f.close();
  }
});

test("a failed restore delivery is retryable by POST or reopening the owner's recycle bin", async () => {
  const f = await fixture();

  try {
    await f.request(`/canvases/${f.id}/collaboration/view`);
    const namespace = {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async () => {
          throw new Error("temporary room outage");
        },
      }),
    };

    for (const retry of ["POST", "GET"]) {
      const catalog = await (
        await f.request(`/workspaces/${f.workspaceId}/canvases`)
      ).json();

      assert.equal(
        (
          await f.request(`/canvases/${f.id}`, "DELETE", {
            catalogRevision: catalog.catalogRevision,
          })
        ).status,
        200,
      );
      assert.equal(
        await f.context(() => restoreRecycleEntry("canvas", f.id, f.owner.id)),
        1,
      );
      await assert.rejects(
        f.context(() => syncRecycleRooms(namespace)),
        /temporary room outage/,
      );
      assert.equal(
        (await f.request(`/canvases/${f.id}/collaboration/view`)).status,
        503,
      );
      const repaired =
        retry === "POST"
          ? await f.request(`/recycle-bin/canvas/${f.id}`, "POST", {})
          : await f.request("/recycle-bin");

      assert.equal(repaired.status, 200);
      assert.equal(
        (await f.request(`/canvases/${f.id}/collaboration/view`)).status,
        200,
      );
      assert.equal(
        (await f.database.select().from(canvases))[0]!.recyclePending,
        0,
      );
    }
  } finally {
    await f.close();
  }
});

test("expiry cleanup paginates past a full page of persistently failing rooms", async () => {
  const f = await fixture();

  try {
    const deletedAt = new Date(Date.now() - RECYCLE_RETENTION).toISOString();
    const failures = Array.from({ length: 100 }, (_, index) => ({
      id: `aa-failed-${String(index).padStart(3, "0")}`,
      workspaceId: f.workspaceId,
      name: "failed",
      createdAt: deletedAt,
      updatedAt: deletedAt,
      deletedAt,
      purging: 1,
      syncMode: "collaborative" as const,
      roomEpoch: "old",
    }));

    await f.database.insert(canvases).values([
      ...failures,
      {
        id: "zz-expired-legacy",
        workspaceId: f.workspaceId,
        name: "legacy",
        createdAt: deletedAt,
        updatedAt: deletedAt,
        deletedAt,
      },
    ]);
    const namespace = {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async () => {
          throw new Error("failed room");
        },
      }),
    };

    await assert.rejects(
      f.context(() => collectRecycleBin(namespace)),
      AggregateError,
    );
    assert.equal(
      (
        await f.database
          .select()
          .from(canvases)
          .where(eq(canvases.id, "zz-expired-legacy"))
      ).length,
      0,
    );
    assert.equal(
      (await f.database.select().from(canvases)).filter((row) => row.purging)
        .length,
      100,
    );
  } finally {
    await f.close();
  }
});
