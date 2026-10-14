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
  const presence = (clientId: string, leave = false) =>
    request(`/canvases/${id}/presence`, "POST", { clientId, leave });

  return {
    ...storage,
    request,
    presence,
    id,
    owner,
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

test("single editor reads, refreshes and saves without persisting a room; simultaneous second session promotes once", async () => {
  const f = await fixture();

  try {
    assert.equal((await f.request(`/canvases/${f.id}`)).status, 200);
    assert.equal((await (await f.presence(a)).json()).syncMode, "legacy");
    assert.equal((await (await f.presence(a)).json()).syncMode, "legacy");
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
      (await (await f.presence(a)).json()).syncMode,
      "collaborative",
    );
    assert.equal(
      (await f.database.select().from(collaborationRooms)).length,
      1,
    );
    assert.deepEqual(await f.database.select().from(canvasSessions), []);
  } finally {
    await f.close();
  }
});

test("leaving, refresh identity and expiration do not mistake historical opens for concurrent editors", async () => {
  const f = await fixture();

  try {
    await withDatabase(f.database, async () => {
      assert.equal(await touchCanvasSession(f.id, a, 1_000), false);
      assert.equal(await touchCanvasSession(f.id, a, 1_500), false);
      await leaveCanvasSession(f.id, a);
      assert.equal(await touchCanvasSession(f.id, b, 2_000), false);
      assert.equal(
        await touchCanvasSession(f.id, a, 2_001 + CANVAS_SESSION_TTL),
        false,
      );
      assert.equal(
        await touchCanvasSession(f.id, b, 2_002 + CANVAS_SESSION_TTL),
        true,
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
    assert.equal(
      (await f.request(`/canvases/${f.id}/collaboration/manage`)).status,
      200,
    );
    assert.equal(
      (await f.database.select().from(collaborationRooms)).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("preparing reads expose authoritative collaborative metadata and conditional validation; restore retains the original migration epoch", async () => {
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
      `"collaboration:${value.roomEpoch}:${value.revision}:${encodeURIComponent(value.name)}"`,
    );
    const conditional = await f.request(
      `/canvases/${f.id}`,
      "GET",
      undefined,
      undefined,
      { "If-None-Match": response.headers.get("etag")! },
    );

    assert.equal(conditional.status, 304);
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
