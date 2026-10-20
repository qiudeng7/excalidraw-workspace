// 使用真实 H3、临时 SQLite 和协作存储验证懒迁移、会话及条件读取；不覆盖浏览器或云端部署。
// 置顶改变协作元数据缓存标识，不改变房间 epoch/seq、场景或内容版本。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { nodeStorage } from "./support/storage";
import { handleApi } from "./support/api";
import { withDatabase } from "../lib/database";
import {
  canvasSessionKey,
  countCanvasSessions,
  touchCanvasSession,
  leaveCanvasSession,
  CANVAS_SESSION_TTL,
} from "../../server/collaboration/open-sessions";
import {
  canvases,
  canvasSessions,
  collaborationRooms,
} from "../../server/db/schema";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lazy-collaboration-"));
  const storage = await nodeStorage(directory);
  const origin = "https://lazy-collaboration.test";
  const pending: Promise<unknown>[] = [];
  let cookie = "";
  let blob = storage.blob;
  const request = (
    path: string,
    method = "GET",
    value?: unknown,
    customCookie = cookie,
    headers: Record<string, string> = {},
  ) =>
    handleApi(
      new Request(`${origin}/api${path}`, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Requested-With": "excalidraw-demo",
          Cookie: customCookie,
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
    email: "lazy-owner@example.test",
    password: "LazyCollaborationPassword123!",
  });

  assert.equal(auth.status, 200);
  cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
  const owner = (await auth.json()).user;
  const spaces = (await (await request("/workspaces")).json()).workspaces;
  const catalog = await (
    await request(`/workspaces/${spaces[0].id}/canvases`)
  ).json();
  const id = catalog.canvases[0].id;
  const leases = new Map<string, number>();
  const presence = async (clientId: string, leave = false) => {
    const response = await request(`/canvases/${id}/presence`, "POST", {
      clientId,
      leave,
      ...(leave ? { leaseExpiresAt: leases.get(clientId) } : {}),
    });
    const value = await response.clone().json();

    if (value.leaseExpiresAt) leases.set(clientId, value.leaseExpiresAt);

    return response;
  };

  return {
    ...storage,
    request,
    presence,
    id,
    workspaceId: spaces[0].id,
    owner,
    cookie,
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
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
};
const a = "client-aaaaaaaaaaaa";
const b = "client-bbbbbbbbbbbb";
const touchCount = async (...args: Parameters<typeof touchCanvasSession>) =>
  (await touchCanvasSession(...args)).participants;

async function presenceState(response: Response) {
  const { leaseExpiresAt, access, epoch, seq, name, ...value } =
    await response.json();

  if (access !== undefined) {
    assert.equal(typeof epoch, "string");
    assert.ok(Number.isSafeInteger(seq));
    assert.equal(typeof name, "string");
  }

  if (leaseExpiresAt !== undefined)
    assert.ok(Number.isSafeInteger(leaseExpiresAt));

  return value;
}

test("single editor reads, refreshes and saves without persisting a room; simultaneous second session promotes once", async () => {
  const f = await fixture();

  try {
    assert.equal((await f.request(`/canvases/${f.id}`)).status, 200);
    assert.equal((await presenceState(await f.presence(a))).syncMode, "legacy");
    assert.equal((await presenceState(await f.presence(a))).syncMode, "legacy");
    const saved = await f.request(`/canvases/${f.id}`, "PUT", {
      revision: 0,
      scene,
    });

    assert.equal(saved.status, 200);
    assert.deepEqual(await f.database.select().from(collaborationRooms), []);
    const concurrent = await Promise.all([f.presence(a), f.presence(b)]);

    for (const response of concurrent)
      assert.equal(response.status, 200, await response.text());
    assert.equal(
      (await f.database.select().from(collaborationRooms)).length,
      1,
    );
    const view = await (
      await f.request(`/canvases/${f.id}/collaboration/view`)
    ).json();

    assert.equal(view.scene.appState.viewBackgroundColor, "#ffffff");
    await f.presence(a, true);
    await f.presence(b, true);
    assert.equal(
      (await presenceState(await f.presence(a))).syncMode,
      "collaborative",
    );
    assert.equal(
      (await f.database.select().from(collaborationRooms)).length,
      1,
    );
    assert.equal((await f.database.select().from(canvasSessions)).length, 1);
  } finally {
    await f.close();
  }
});

test("leaving, refresh identity and expiration do not mistake historical opens for concurrent editors", async () => {
  const f = await fixture();

  try {
    await withDatabase(f.database, async () => {
      const actor = { principalId: `user:${f.owner.id}`, grantId: "owner" };
      const first = await canvasSessionKey(actor, a);
      const second = await canvasSessionKey(actor, b);

      assert.equal(await touchCount(f.id, first, 1_000), 1);
      assert.equal(await touchCount(f.id, first, 1_500), 1);
      await leaveCanvasSession(f.id, first);
      assert.equal(await touchCount(f.id, second, 2_000), 1);
      assert.equal(
        await touchCount(f.id, first, 2_001 + CANVAS_SESSION_TTL),
        1,
      );
      assert.equal(
        await touchCount(f.id, second, 2_002 + CANVAS_SESSION_TTL),
        2,
      );
      assert.equal(
        await touchCount(
          f.id,
          await canvasSessionKey(actor, "client-cccccccccccc"),
          2_003 + CANVAS_SESSION_TTL,
        ),
        3,
      );
    });
    assert.deepEqual(await f.database.select().from(collaborationRooms), []);
  } finally {
    await f.close();
  }
});

test("upgrade fences a save after Blob upload and retains the last published snapshot", async () => {
  const f = await fixture();
  let release!: () => void;
  let uploaded!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    uploaded = resolve;
  });

  try {
    await f.presence(a);
    const original = f.blob;

    f.interceptBlob({
      ...original,
      put: async (...args: Parameters<typeof original.put>) => {
        const result = await original.put(...args);

        if (args[0].startsWith(`${f.owner.id}/canvas/`)) {
          uploaded();
          await waiting;
        }

        return result;
      },
    });
    const saving = f.request(`/canvases/${f.id}`, "PUT", {
      revision: 0,
      scene,
    });

    await entered;
    assert.equal((await f.presence(b)).status, 200);
    release();
    assert.equal((await saving).status, 409);
    const row = (
      await f.database.select().from(canvases).where(eq(canvases.id, f.id))
    )[0]!;

    assert.equal(row.syncMode, "collaborative");
    assert.equal(row.objectKey, null);
    const view = await (
      await f.request(`/canvases/${f.id}/collaboration/view`)
    ).json();

    assert.deepEqual(view.scene.elements, []);
    assert.deepEqual(view.scene.appState, {});
  } finally {
    release?.();
    await f.close();
  }
});

test("presence is owner-only while explicit sharing creates the required room", async () => {
  const f = await fixture();

  try {
    assert.equal(
      (
        await f.request(
          `/canvases/${f.id}/presence`,
          "POST",
          { clientId: a },
          "",
        )
      ).status,
      401,
    );
    const user = await f.request("/register", "POST", {
      email: "lazy-other@example.test",
      password: "OtherLazyPassword123!",
    });
    const otherCookie = user.headers.get("set-cookie")!.split(";")[0]!;

    assert.equal(
      (
        await f.request(
          `/canvases/${f.id}/presence`,
          "POST",
          { clientId: a },
          otherCookie,
        )
      ).status,
      404,
    );
    assert.deepEqual(await f.database.select().from(collaborationRooms), []);
    const manage = await f.request(`/canvases/${f.id}/collaboration/manage`);

    assert.equal(manage.status, 200);
    assert.deepEqual(await manage.json(), {
      members: [],
      links: [],
      versions: [],
      accessRevision: 0,
    });
    assert.deepEqual(await f.database.select().from(collaborationRooms), []);
    assert.equal(
      (await f.database.select().from(canvases))[0]!.syncMode,
      "legacy",
    );
    await activateRoom(f);
    assert.equal(
      (await f.database.select().from(collaborationRooms)).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("迁移中读取返回权威协作元数据，置顶更新ETag但不改场景seq，恢复保留迁移epoch", async () => {
  const f = await fixture();

  try {
    await f.presence(a);
    await f.presence(b);
    await f.database
      .update(canvases)
      .set({ syncMode: "preparing" })
      .where(eq(canvases.id, f.id));
    const response = await f.request(`/canvases/${f.id}`);
    const value = (await response.json()).canvas;

    assert.equal(value.syncMode, "collaborative");
    assert.equal(value.migrationEpoch, value.roomEpoch);
    assert.equal(
      response.headers.get("etag"),
      `"collaboration:${value.roomEpoch}:${value.revision}:${encodeURIComponent(value.name)}:false"`,
    );
    const conditional = await f.request(
      `/canvases/${f.id}`,
      "GET",
      undefined,
      undefined,
      { "If-None-Match": response.headers.get("etag")! },
    );

    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), "");
    assert.equal(value.pinned, false);
    const catalog = await (
      await f.request(`/workspaces/${f.workspaceId}/canvases`)
    ).json();
    const beforePinView = await (
      await f.request(`/canvases/${f.id}/collaboration/view`)
    ).json();
    const pin = await f.request(`/canvases/${f.id}/pin`, "PUT", {
      pinned: true,
      catalogRevision: catalog.catalogRevision,
    });

    assert.equal(pin.status, 200);
    const changed = await f.request(
      `/canvases/${f.id}`,
      "GET",
      undefined,
      undefined,
      { "If-None-Match": response.headers.get("etag")! },
    );

    assert.equal(changed.status, 200);
    const pinned = (await changed.json()).canvas;

    assert.equal(pinned.pinned, true);
    assert.equal(pinned.revision, value.revision);
    assert.equal(pinned.updatedAt, value.updatedAt);
    assert.equal(pinned.roomEpoch, value.roomEpoch);
    assert.deepEqual(pinned.scene, value.scene);
    assert.notEqual(changed.headers.get("etag"), response.headers.get("etag"));
    assert.ok(changed.headers.get("etag"));
    const afterPinView = await (
      await f.request(`/canvases/${f.id}/collaboration/view`)
    ).json();

    assert.equal(afterPinView.seq, beforePinView.seq);
    assert.equal(afterPinView.epoch, beforePinView.epoch);
    assert.deepEqual(afterPinView.scene, beforePinView.scene);
    const freshConditional = await f.request(
      `/canvases/${f.id}`,
      "GET",
      undefined,
      undefined,
      { "If-None-Match": changed.headers.get("etag")! },
    );

    assert.equal(freshConditional.status, 304);
    assert.equal(await freshConditional.text(), "");
    const backup = await (
      await f.request(`/canvases/${f.id}/collaboration/backup`)
    ).json();
    const restore = await f.request(
      `/canvases/${f.id}/collaboration/restore`,
      "POST",
      {
        backup,
        expectedEpoch: backup.state.epoch,
        expectedSeq: backup.state.seq,
        expectedAccessRevision: backup.state.accessRevision,
      },
    );

    assert.equal(restore.status, 200, await restore.text());
    const restored = (await (await f.request(`/canvases/${f.id}`)).json())
      .canvas;

    assert.equal(restored.migrationEpoch, value.migrationEpoch);
    assert.notEqual(restored.roomEpoch, restored.migrationEpoch);
  } finally {
    await f.close();
  }
});

test("an existing room remains a single participant until a second tab arrives, with consistent owner identity across endpoints", async () => {
  const f = await fixture();

  try {
    assert.deepEqual(await presenceState(await f.presence(a)), {
      syncMode: "legacy",
      participants: 1,
      realtime: false,
    });
    await activateRoom(f);
    const row = (
      await f.database.select().from(canvases).where(eq(canvases.id, f.id))
    )[0]!;

    // Old deployments stored a raw tab ID. It must not double-count after upgrade.
    await f.database.insert(canvasSessions).values({
      canvasId: f.id,
      clientId: a,
      expiresAt: Date.now() + CANVAS_SESSION_TTL,
    });
    const leases = new Map<string, number>();
    const presence = async (clientId: string, leave = false) => {
      const response = await f.request(
        `/canvases/${f.id}/collaboration/presence`,
        "POST",
        {
          clientId,
          leave,
          leaseExpiresAt: leases.get(clientId),
        },
      );
      const value = await response.clone().json();

      if (value.leaseExpiresAt) leases.set(clientId, value.leaseExpiresAt);

      return response;
    };

    assert.deepEqual(await presenceState(await presence(a)), {
      participants: 1,
      realtime: false,
    });
    assert.deepEqual(await presenceState(await presence(b)), {
      participants: 2,
      realtime: true,
    });
    assert.deepEqual(
      await presenceState(await presence("client-cccccccccccc")),
      {
        participants: 3,
        realtime: true,
      },
    );
    assert.equal((await presenceState(await f.presence(a))).participants, 3);
    assert.deepEqual(await presenceState(await presence(b, true)), {
      participants: 2,
      realtime: true,
    });
    await presence("client-cccccccccccc", true);
    assert.deepEqual(await presenceState(await presence(a)), {
      participants: 1,
      realtime: false,
    });
    const after = (
      await f.database.select().from(canvases).where(eq(canvases.id, f.id))
    )[0]!;

    assert.equal(after.syncMode, "collaborative");
    assert.equal(after.roomEpoch, row.roomEpoch);
  } finally {
    await f.close();
  }
});

test("presence isolates identical tab IDs by authorized account and cannot leave another participant", async () => {
  const f = await fixture();

  try {
    const registration = await f.request("/register", "POST", {
      email: "presence-other@example.test",
      password: "OtherLazyPassword123!",
    });
    const otherCookie = registration.headers.get("set-cookie")!.split(";")[0]!;
    const leases = new Map<string, number>();
    const presence = async (cookie: string, leave = false) => {
      const response = await f.request(
        `/canvases/${f.id}/collaboration/presence`,
        "POST",
        { clientId: a, leave, leaseExpiresAt: leases.get(cookie) },
        cookie,
      );
      const value = await response.clone().json();

      if (value.leaseExpiresAt) leases.set(cookie, value.leaseExpiresAt);

      return response;
    };

    // A delayed leave cannot initialize a legacy room.
    assert.equal((await presence(f.cookie, true)).status, 404);
    assert.deepEqual(await f.database.select().from(collaborationRooms), []);
    await activateRoom(f);
    assert.deepEqual(await presenceState(await presence(f.cookie)), {
      participants: 1,
      realtime: false,
    });
    assert.equal((await presence(otherCookie, true)).status, 403);
    assert.equal((await f.database.select().from(canvasSessions)).length, 1);
    assert.equal(
      (
        await f.request(`/canvases/${f.id}/collaboration/members`, "POST", {
          email: "presence-other@example.test",
          role: "editor",
          viewMode: "live",
        })
      ).status,
      200,
    );
    assert.deepEqual(await presenceState(await presence(otherCookie)), {
      participants: 2,
      realtime: true,
    });
    assert.deepEqual(await presenceState(await presence(otherCookie, true)), {
      participants: 1,
      realtime: false,
    });
    assert.deepEqual(await presenceState(await presence(f.cookie)), {
      participants: 1,
      realtime: false,
    });
    const snapshot = await f.database.select().from(canvasSessions);

    assert.equal((await presence("", true)).status, 401);
    assert.deepEqual(await f.database.select().from(canvasSessions), snapshot);
  } finally {
    await f.close();
  }
});

test("live share viewers count, fixed/latest viewers do not, and revoked links cannot mutate leases", async () => {
  const f = await fixture();

  try {
    assert.equal(
      (
        await f.request(`/canvases/${f.id}/collaboration/versions`, "POST", {
          id: "presence-snapshot",
          label: "Presence snapshot",
        })
      ).status,
      200,
    );
    await f.presence(a);
    const links: Record<string, { id: string; token: string }> = {};

    for (const viewMode of ["live", "latest", "fixed"]) {
      const link = await (
        await f.request(`/canvases/${f.id}/collaboration/links`, "POST", {
          role: "viewer",
          viewMode,
          requireLogin: false,
          ...(viewMode === "fixed" ? { snapshotId: "presence-snapshot" } : {}),
        })
      ).json();
      const exchange = await f.request(
        `/canvases/${f.id}/collaboration/exchange`,
        "POST",
        { secret: link.path.split("#")[1] },
        "",
      );

      links[viewMode] = { id: link.id, token: (await exchange.json()).token };
    }

    const presence = (viewMode: string, leave = false) =>
      f.request(
        `/canvases/${f.id}/collaboration/presence`,
        "POST",
        { clientId: a, leave },
        "",
        { "x-canvas-access": links[viewMode]!.token },
      );

    for (const viewMode of ["latest", "fixed"])
      assert.deepEqual(await presenceState(await presence(viewMode)), {
        participants: 1,
        realtime: false,
      });
    assert.deepEqual(await presenceState(await presence("live")), {
      participants: 2,
      realtime: true,
    });
    assert.deepEqual(await presenceState(await presence("latest")), {
      participants: 2,
      realtime: false,
    });
    const snapshot = await f.database.select().from(canvasSessions);

    await f.request(`/canvases/${f.id}/collaboration/links`, "DELETE", {
      id: links.live!.id,
    });
    assert.equal((await presence("live", true)).status, 403);
    assert.deepEqual(await f.database.select().from(canvasSessions), snapshot);
    await withDatabase(f.database, async () => {
      assert.equal(
        await countCanvasSessions(f.id, Date.now() + CANVAS_SESSION_TTL + 1),
        0,
      );
    });
  } finally {
    await f.close();
  }
});

test("renewed leases reject delayed leaves and account link context does not duplicate a tab", async () => {
  const f = await fixture();

  try {
    const first = await (await f.presence(a)).json();
    const link = await (
      await f.request(`/canvases/${f.id}/collaboration/links`, "POST", {
        role: "editor",
        requireLogin: true,
      })
    ).json();
    const exchanged = await (
      await f.request(`/canvases/${f.id}/collaboration/exchange`, "POST", {
        secret: link.path.split("#")[1],
      })
    ).json();
    const renewed = await (
      await f.request(
        `/canvases/${f.id}/collaboration/presence`,
        "POST",
        {
          clientId: a,
        },
        f.cookie,
        { "x-canvas-access": exchanged.token },
      )
    ).json();

    assert.equal(renewed.participants, 1);
    assert.equal(renewed.realtime, false);
    assert.ok(renewed.leaseExpiresAt > first.leaseExpiresAt);
    for (const leaseExpiresAt of [undefined, first.leaseExpiresAt]) {
      const response = await f.request(`/canvases/${f.id}/presence`, "POST", {
        clientId: a,
        leave: true,
        leaseExpiresAt,
      });

      assert.equal((await response.json()).participants, 1);
    }

    const left = await f.request(
      `/canvases/${f.id}/collaboration/presence`,
      "POST",
      {
        clientId: a,
        leave: true,
        leaseExpiresAt: renewed.leaseExpiresAt,
      },
    );

    assert.deepEqual(await presenceState(left), {
      participants: 0,
      realtime: false,
    });
    await withDatabase(f.database, async () => {
      const key = await canvasSessionKey(
        { principalId: `user:${f.owner.id}` },
        a,
      );
      const first = await touchCanvasSession(f.id, key, 1_000);
      const second = await touchCanvasSession(f.id, key, 1_000);

      assert.equal(second.leaseExpiresAt, first.leaseExpiresAt + 1);
      await leaveCanvasSession(f.id, key, first.leaseExpiresAt);
      assert.equal(await countCanvasSessions(f.id, 1_000), 1);
      await leaveCanvasSession(f.id, key, second.leaseExpiresAt);
      assert.equal(await countCanvasSessions(f.id, 1_000), 0);
    });
  } finally {
    await f.close();
  }
});

async function activateRoom(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(
    (
      await f.request(`/canvases/${f.id}/collaboration/links`, "POST", {
        role: "viewer",
        requireLogin: true,
      })
    ).status,
    200,
  );
}

test("legacy collaboration probes and owner location are read-only and do not disclose another owner's directory", async () => {
  const f = await fixture();

  try {
    const registration = await f.request("/register", "POST", {
      email: "probe-other@example.test",
      password: "ProbeOtherPassword123!",
    });
    const otherCookie = registration.headers.get("set-cookie")!.split(";")[0]!;
    const before = await f.database.select().from(canvases);
    const original = f.blob;
    let reads = 0;
    let writes = 0;

    f.interceptBlob({
      ...original,
      get: async (...args: Parameters<typeof original.get>) => {
        reads++;

        return original.get(...args);
      },
      put: async (...args: Parameters<typeof original.put>) => {
        writes++;

        return original.put(...args);
      },
    });
    for (const route of ["access", "view", "backup", "manage"]) {
      const owner = await f.request(`/canvases/${f.id}/collaboration/${route}`);

      assert.equal(owner.status, route === "manage" ? 200 : 409);
      for (const cookie of [otherCookie, ""]) {
        const denied = await f.request(
          `/canvases/${f.id}/collaboration/${route}`,
          "GET",
          undefined,
          cookie,
        );

        assert.ok([401, 404].includes(denied.status));
        assert.equal(
          JSON.stringify(await denied.json()).includes(f.workspaceId),
          false,
        );
      }
    }

    const location = await f.request(`/canvases/${f.id}/owner-location`);

    assert.equal(location.status, 200);
    assert.deepEqual(await location.json(), {
      workspaceId: f.workspaceId,
      canvasId: f.id,
    });
    for (const id of [f.id, "missing-canvas"]) {
      const response = await f.request(
        `/canvases/${id}/owner-location`,
        "GET",
        undefined,
        otherCookie,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {});
    }

    assert.deepEqual(await f.database.select().from(canvases), before);
    assert.deepEqual(await f.database.select().from(collaborationRooms), []);
    assert.deepEqual(await f.database.select().from(canvasSessions), []);
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    await activateRoom(f);
    assert.deepEqual(
      await (await f.request(`/canvases/${f.id}/owner-location`)).json(),
      {},
    );
  } finally {
    await f.close();
  }
});

test("collaboration presence returns authorized lightweight watermarks without hydrating images or writing the room", async () => {
  const f = await fixture();

  try {
    await activateRoom(f);
    const image = {
      id: "status-image",
      mimeType: "image/png",
      created: Date.now(),
      dataURL: "data:image/png;base64,aGVsbG8=",
    };

    assert.equal(
      (await f.request(`/canvases/${f.id}/collaboration/assets`, "POST", image))
        .status,
      200,
    );
    const initial = await (
      await f.request(`/canvases/${f.id}/collaboration/view`)
    ).json();

    assert.equal(
      (
        await f.request(`/canvases/${f.id}/collaboration/update`, "POST", {
          protocolVersion: 1,
          epoch: initial.epoch,
          clientId: a,
          clientSeq: 1,
          opId: "status-image-operation",
          baseSeq: initial.seq,
          elements: [
            {
              id: "status-image-element",
              type: "image",
              fileId: image.id,
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              angle: 0,
              index: "a0",
              version: 1,
              versionNonce: 5,
            },
          ],
        })
      ).status,
      200,
    );
    const view = await (
      await f.request(`/canvases/${f.id}/collaboration/view`)
    ).json();

    assert.equal(view.scene.files[image.id].dataURL, image.dataURL);
    const rooms = await f.database.select().from(collaborationRooms);
    const original = f.blob;
    let reads = 0;
    let writes = 0;

    f.interceptBlob({
      ...original,
      get: async (...args: Parameters<typeof original.get>) => {
        reads++;

        return original.get(...args);
      },
      put: async (...args: Parameters<typeof original.put>) => {
        writes++;

        return original.put(...args);
      },
    });
    const response = await f.request(
      `/canvases/${f.id}/collaboration/presence`,
      "POST",
      { clientId: a },
    );
    const status = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(status.access, view.access);
    assert.equal(status.epoch, view.epoch);
    assert.equal(status.seq, view.seq);
    assert.equal(status.name, view.name);
    assert.equal(status.participants, 1);
    assert.equal(status.realtime, false);
    assert.deepEqual(
      Object.keys(status).sort(),
      [
        "access",
        "epoch",
        "seq",
        "name",
        "participants",
        "leaseExpiresAt",
        "realtime",
      ].sort(),
    );
    assert.equal(JSON.stringify(status).includes("data:image"), false);
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    assert.deepEqual(await f.database.select().from(collaborationRooms), rooms);
  } finally {
    await f.close();
  }
});

for (const route of ["access", "view", "backup", "manage"]) {
  test(`preparing collaboration ${route} read resumes an interrupted migration`, async () => {
    const f = await fixture();

    try {
      await f.database
        .update(canvases)
        .set({
          syncMode: "preparing",
          roomEpoch: "pending-epoch",
          migrationEpoch: "pending-epoch",
        })
        .where(eq(canvases.id, f.id));
      const response = await f.request(
        `/canvases/${f.id}/collaboration/${route}`,
      );

      assert.equal(response.status, 200);
      const row = (await f.database.select().from(canvases))[0]!;

      assert.equal(row.syncMode, "collaborative");
      assert.equal(row.roomEpoch, "pending-epoch");
      assert.equal(
        (await f.database.select().from(collaborationRooms)).length,
        1,
      );
      assert.deepEqual(
        await (await f.request(`/canvases/${f.id}/owner-location`)).json(),
        {},
      );
    } finally {
      await f.close();
    }
  });
}

test("owner location identifies each legacy canvas in its own workspace", async () => {
  const f = await fixture();

  try {
    const created = await f.request("/workspaces", "POST", {
      name: "Second workspace",
    });

    assert.equal(created.status, 200);
    const workspace = (await created.json()).workspace;
    const createdCanvas = await f.request(
      `/workspaces/${workspace.id}/canvases`,
      "POST",
      { name: "Second canvas", catalogRevision: 0 },
    );

    assert.equal(createdCanvas.status, 200);
    const canvas = (await createdCanvas.json()).canvas;
    const before = await f.database.select().from(canvases);

    for (const [canvasId, workspaceId] of [
      [f.id, f.workspaceId],
      [canvas.id, workspace.id],
    ]) {
      const response = await f.request(`/canvases/${canvasId}/owner-location`);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { canvasId, workspaceId });
      assert.equal(
        (await f.request(`/canvases/${canvasId}/collaboration/manage`)).status,
        200,
      );
    }

    assert.deepEqual(
      await (await f.request("/canvases/missing-canvas/owner-location")).json(),
      {},
    );
    assert.deepEqual(await f.database.select().from(canvases), before);
    assert.deepEqual(await f.database.select().from(collaborationRooms), []);
  } finally {
    await f.close();
  }
});
