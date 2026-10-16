import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import "fake-indexeddb/auto";
import { CollaborationSession } from "../../src/lib/collaboration/session";
import {
  createRoom,
  execute,
  type Command,
} from "../../shared/collaboration/room";

test("authoritative lightweight heartbeats preserve convergence and automatic realtime grace", async () => {
  const names = [
    "fetch",
    "navigator",
    "sessionStorage",
    "location",
    "window",
    "document",
    "WebSocket",
  ];
  const originals = new Map(
    names.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true });
  const now = Date.now;
  let clock = now();

  Date.now = () => clock;
  const room = createRoom("demand-room", "owner", "Solo", "epoch", {
    elements: [],
    appState: {},
    files: {},
  });
  const actor = { userId: "owner", name: "Owner" };
  let participants = 1;
  let failPresence = false;
  const counts = { access: 0, presence: 0, view: 0, ticket: 0 };

  class Socket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;

    constructor() {
      super();
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }

    send() {} // No READY: HTTP must converge without WebSocket help.

    close() {
      this.readyState = 3;
      this.dispatchEvent(
        Object.assign(new Event("close"), { code: 1000, wasClean: true }),
      );
    }
  }

  define("navigator", {});
  define("sessionStorage", { getItem: () => "demand-tab", setItem() {} });
  define("location", { origin: "https://demand.test" });
  define("window", new EventTarget());
  define(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  define("WebSocket", Socket);
  define("fetch", async (url: string, init: RequestInit) => {
    const path = url.split("/").at(-1) as keyof typeof counts;

    counts[path]++;
    if (path === "presence") {
      if (JSON.parse(String(init.body)).leave) return Response.json({});
      if (failPresence) throw new Error("heartbeat unavailable");

      return Response.json({
        ...(execute(room, actor, { type: "status" }, clock) as object),
        participants,
        realtime: participants > 1,
        leaseExpiresAt: clock + 150_000,
      });
    }

    if (path === "ticket") return Response.json({ ticket: "ticket" });

    return Response.json(
      execute(room, actor, { type: path } as Command, clock),
    );
  });
  const session = new CollaborationSession({
    canvasId: room.id,
    userId: "owner",
    scope: "demand",
  });
  const unsubscribe = session.subscribe(() => {});
  const internals = session as unknown as {
    pollPresence(): Promise<void>;
    soloSince?: number;
    socket?: unknown;
  };
  const settle = async (predicate: () => boolean) => {
    for (let i = 0; i < 1000 && !predicate(); i++) await setImmediate();
    assert.ok(predicate(), "asynchronous request settled");
  };

  try {
    assert.match(session.realtimeText, /待确认/);
    await session.start();
    await settle(() => session.presenceKnown);
    assert.deepEqual(counts, { access: 1, presence: 1, view: 1, ticket: 0 });
    for (let i = 0; i < 4; i++) {
      clock += 15_000;
      await internals.pollPresence();
    }

    assert.deepEqual(
      counts,
      { access: 1, presence: 5, view: 1, ticket: 0 },
      "60 seconds: four lightweight polls, zero duplicate access/full views/tickets",
    );
    assert.match(session.realtimeText, /独自编辑.*休眠/);
    session.view!.access.role = "viewer";
    assert.match(session.realtimeText, /仅你在查看.*休眠/);
    session.view!.access.role = "owner";
    clock += 46_000;
    assert.match(
      session.realtimeText,
      /待确认/,
      "expired presence is not a solo claim",
    );
    await internals.pollPresence();
    // Another tab edits and leaves between heartbeats: solo is not proof of freshness.
    room.seq++;
    await internals.pollPresence();
    assert.equal(counts.view, 2);
    room.name = "Changed between polls";
    await internals.pollPresence();
    assert.equal(
      counts.view,
      3,
      "name-only change refreshes without a seq bump",
    );
    assert.equal(session.view?.name, room.name);
    participants = 2;
    await internals.pollPresence();
    await settle(() => counts.ticket === 1);
    assert.match(session.realtimeText, /2 个会话/);
    room.seq++;
    await internals.pollPresence();
    assert.equal(
      session.view?.seq,
      room.seq,
      "HTTP convergence works without READY",
    );
    participants = 1;
    await internals.pollPresence();
    clock += 15_000;
    await internals.pollPresence();
    assert.ok(internals.socket, "retain realtime during grace");
    participants = 2;
    await internals.pollPresence();
    assert.equal(
      internals.soloSince,
      undefined,
      "returning peer cancels grace",
    );
    participants = 1;
    await internals.pollPresence();
    clock += 30_000;
    failPresence = true;
    await internals.pollPresence();
    assert.equal(session.presenceKnown, false);
    assert.match(session.realtimeText, /待确认/);
    assert.ok(internals.socket, "failed count cannot prove departure");
    failPresence = false;
    await internals.pollPresence();
    clock += 30_000;
    await internals.pollPresence();
    assert.equal(internals.socket, undefined);
    assert.equal(session.realtimeStatus, "idle");
    assert.equal(session.view?.seq, room.seq);
    room.epoch = "restored";
    await internals.pollPresence();
    assert.equal(
      session.status,
      "ready",
      "clean epoch change loads the restored authority",
    );
    assert.equal(session.view?.epoch, "restored");
    session.update({
      elements: [
        {
          id: "local",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
        },
      ],
      appState: {},
      files: {},
    });
    assert.equal(session.dirty, true);
    room.epoch = "restored-again";
    await internals.pollPresence();
    assert.equal(
      session.status,
      "recovery",
      "old draft cannot cross a restored epoch",
    );
    assert.equal(session.dirty, true);
    assert.equal(session.editable, false);
    assert.equal(internals.socket, undefined);
  } finally {
    unsubscribe();
    await session.dispose();
    Date.now = now;
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

for (const viewMode of ["latest", "fixed"] as const) {
  test(`${viewMode} checks access without automatically loading updates or restored epochs`, async () => {
    const names = ["fetch", "navigator", "sessionStorage"];
    const originals = new Map(
      names.map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );
    const define = (key: string, value: unknown) =>
      Object.defineProperty(globalThis, key, { value, configurable: true });
    const room = createRoom(
      `manual-${viewMode}`,
      "owner",
      "Original",
      "original",
      { elements: [], appState: {}, files: {} },
    );

    room.versions.push({
      id: "snapshot",
      label: "Fixed",
      name: "Original",
      epoch: "original",
      seq: 0,
      createdAt: new Date().toISOString(),
      createdBy: "owner",
      sceneKey: "snapshot",
      files: {},
    });
    room.members.push({
      id: "grant",
      userId: "viewer",
      name: "Viewer",
      role: "viewer",
      viewMode,
      ...(viewMode === "fixed" ? { snapshotId: "snapshot" } : {}),
    });
    let views = 0;

    define("navigator", {});
    define("sessionStorage", {
      getItem: () => `manual-${viewMode}`,
      setItem() {},
    });
    define("fetch", async (url: string) => {
      const path = url.split("/").at(-1)!;

      if (path === "view") views++;
      try {
        return Response.json(
          execute(
            room,
            { userId: "viewer", name: "Viewer" },
            { type: path } as Command,
            Date.now(),
          ),
        );
      } catch (error) {
        assert.ok(error);

        return Response.json(
          { error: { code: "ACCESS_DENIED", message: "权限已撤销" } },
          { status: 403 },
        );
      }
    });
    const session = new CollaborationSession({
      canvasId: room.id,
      userId: "viewer",
      scope: room.id,
    });
    const unsubscribe = session.subscribe(() => {});

    try {
      await session.start(false);
      room.seq++;
      room.name = "Updated";
      await (
        session as unknown as { pollPresence(): Promise<void> }
      ).pollPresence();
      room.epoch = "restored";
      await (
        session as unknown as { pollPresence(): Promise<void> }
      ).pollPresence();
      assert.equal(views, 1);
      assert.equal(session.view?.name, "Original");
      assert.equal(session.view?.epoch, "original");
      await session.refresh();
      assert.equal(views, 2);
      assert.equal(
        session.view?.name,
        viewMode === "latest" ? "Updated" : "Original",
      );
      room.members = [];
      await (
        session as unknown as { pollPresence(): Promise<void> }
      ).pollPresence();
      assert.equal(session.status, "denied");
      assert.equal(views, 2, "revocation must not read a scene");
    } finally {
      unsubscribe();
      await session.dispose();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
