import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import {
  CollaborationSession,
  collaborationSession,
  closeCollaboration,
  hasUnsyncedCollaboration,
} from "../../src/lib/collaboration/session";
import {
  createRoom,
  execute,
  type Command,
} from "../../shared/collaboration/room";
import { canonical } from "../../shared/collaboration/merge";
import { ConfirmedCache } from "../../src/lib/confirmedCache";
import {
  draftStorage,
  findRecoveryDraft,
  type Draft,
} from "../../src/lib/collaboration/storage";
import type { Operation, Element } from "../../shared/collaboration/types";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Client did not settle");
    await setImmediate();
  }
}

class Socket extends EventTarget {
  static instances: Socket[] = [];
  static authenticated: string[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;

  constructor() {
    super();
    Socket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(raw: string) {
    if (JSON.parse(raw).type === "AUTH") {
      Socket.authenticated.push(JSON.parse(raw).ticket);
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ type: "READY" }),
          }),
        ),
      );
    }
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(
      Object.assign(new Event("close"), {
        code: 1000,
        reason: "",
        wasClean: true,
      }),
    );
  }
}

test("a refresh superseded by an ACK still publishes its confirmed view generation", async () => {
  const originals = Object.fromEntries(
    ["fetch", "navigator", "sessionStorage"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const room = createRoom("view-generation", "owner", "Canvas", "epoch", {
    elements: [],
    appState: {},
    files: {},
  });
  let delayView = false;
  let release!: () => void;
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true });

  define("navigator", {});
  define("sessionStorage", {
    getItem: () => "generation-test",
    setItem: () => {},
  });
  define("fetch", async (url: string, init: RequestInit) => {
    const path = url.split("/").at(-1);
    let command: Command;

    if (path === "access") command = { type: "access" };
    else if (path === "view") command = { type: "view" };
    else if (path === "update") {
      const operation = JSON.parse(String(init.body)) as Operation;

      command = { type: "update", operation, digest: canonical(operation) };
    } else throw new Error(`Unexpected API ${path}`);
    const result = structuredClone(
      execute(room, { userId: "owner", name: "Owner" }, command, Date.now()),
    );

    if (path === "view" && delayView) {
      requested();
      await waiting;
    }

    return Response.json(result);
  });
  const session = new CollaborationSession({
    canvasId: room.id,
    userId: "owner",
    scope: "generation",
  });
  const observed: number[] = [];
  const originalPut = ConfirmedCache.prototype.put;
  let releaseCache = () => {};
  const unsubscribe = session.subscribe(() =>
    observed.push(session.viewGeneration),
  );

  try {
    await session.start(false);
    assert.equal(session.viewGeneration, 1);
    delayView = true;
    const refreshing = session.refresh();

    await started;
    session.update({ elements: [element("a")], appState: {}, files: {} });
    await session.flush();
    assert.equal(session.view?.seq, 1);
    assert.equal(session.viewGeneration, 1);
    release();
    await refreshing;
    assert.equal(
      session.view?.seq,
      1,
      "a delayed GET must not roll back the accepted ACK",
    );
    assert.equal(session.viewGeneration, 2);
    assert.equal(
      observed.at(-1),
      2,
      "the reopening wrapper receives fresh proof even when the GET is ignored",
    );
    delayView = false;
    let cacheEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      cacheEntered = resolve;
    });
    const pendingCache = new Promise<void>((resolve) => {
      releaseCache = resolve;
    });

    ConfirmedCache.prototype.put = async function (key, value, revisionScope) {
      cacheEntered();
      await pendingCache;

      return originalPut.call(this, key, value, revisionScope);
    };

    const startingAgain = session.start(false);

    await entered;
    const mountGeneration = session.viewGeneration;
    const joinedStart = session.start(false);

    releaseCache();
    await Promise.all([startingAgain, joinedStart]);
    assert.equal(
      session.viewGeneration,
      mountGeneration + 1,
      "a wrapper mounting during cache.put observes new proof when the shared start completes",
    );
    assert.equal(observed.at(-1), session.viewGeneration);
  } finally {
    release();
    releaseCache();
    ConfirmedCache.prototype.put = originalPut;
    unsubscribe();
    await session.dispose();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

const element = (id: string, version = 1, x = 0): Element => ({
  id,
  type: "rectangle",
  y: 0,
  width: 100,
  height: 80,
  angle: 0,
  version,
  versionNonce: 42,
  index: id === "a" ? "a0" : "a1",
  x,
});

test("a delayed ACK preserves later edits, local queue survives reload, and retries do not duplicate commits", async () => {
  const originals = Object.fromEntries(
    [
      "indexedDB",
      "navigator",
      "sessionStorage",
      "location",
      "WebSocket",
      "fetch",
    ].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const memory = new Map<string, string>();
  const room = createRoom("client-test", "owner", "Canvas", "epoch", {
    elements: [],
    files: {},
    appState: {},
  });
  let release: (() => void) | undefined;
  let delayAck = true;
  let posts = 0;
  let tickets = 0;
  let failAck = false;
  const responses: Operation[] = [];
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true });

  define("indexedDB", indexedDB);
  define("navigator", {
    locks: {
      request: (
        _name: string,
        _options: unknown,
        callback: (lock: object) => unknown,
      ) => callback({}),
    },
  });
  define("sessionStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
  });
  define("location", { origin: "https://client.test" });
  define("WebSocket", Socket);
  define("fetch", async (url: string, init: RequestInit) => {
    const path = url.split("/").at(-1);
    let command: Command;

    if (path === "presence")
      return Response.json({
        participants: 2,
        realtime: true,
        leaseExpiresAt: Date.now() + 150000,
      });
    if (path === "ticket")
      return Response.json({ ticket: `ticket-${++tickets}` });
    if (path === "access") command = { type: "access" };
    else if (path === "view") command = { type: "view" };
    else if (path === "update") {
      const operation = JSON.parse(String(init.body)) as Operation;

      posts++;
      responses.push(structuredClone(operation));
      command = { type: "update", operation, digest: canonical(operation) };
    } else throw new Error(`Unexpected API ${path}`);
    const result = execute(
      room,
      { userId: "owner", name: "Owner" },
      command,
      Date.now(),
    );

    if (path === "update" && delayAck)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (path === "update" && failAck) {
      failAck = false;
      throw new TypeError("ACK lost");
    }

    return Response.json(result);
  });
  const options = { canvasId: room.id, userId: "owner", scope: "test" };
  let session = collaborationSession(options);
  let unsubscribe = session.subscribe(() => {});

  try {
    await session.start();
    await until(
      () =>
        Socket.authenticated.includes("ticket-1") && session.status === "ready",
    );
    assert.equal(tickets, 1);
    Socket.instances.at(-1)!.close();
    await until(() => tickets === 2 && session.status === "ready");
    assert.deepEqual(Socket.authenticated.slice(-2), ["ticket-1", "ticket-2"]);
    assert.equal(posts, 0, "opening an unchanged canvas must not write");
    session.update({
      elements: [element("a")],
      files: {},
      appState: { viewBackgroundColor: "#ffffff" },
    });
    const saving = session.flush();

    await until(() => !!release);
    unsubscribe();
    assert.equal(
      hasUnsyncedCollaboration("owner"),
      true,
      "a closed view's pending queue must still protect page unload",
    );
    assert.equal(hasUnsyncedCollaboration("another-owner"), false);
    unsubscribe = session.subscribe(() => {});
    session.update({
      elements: [element("a", 2, 100)],
      files: {},
      appState: {},
    });
    delayAck = false;
    release!();
    await saving;
    assert.equal(session.dirty, false);
    assert.equal(hasUnsyncedCollaboration("owner"), false);
    assert.equal(room.scene.elements[0]?.x, 100);
    assert.equal(posts, 2);
    session.update({
      elements: [{ ...element("a", 2, 100), groupIds: [], locked: false }],
      files: {},
      appState: {},
    });
    assert.equal(
      session.dirty,
      false,
      "restoring legacy defaults must not echo a remote element",
    );
    assert.notEqual(responses[0]?.opId, responses[1]?.opId);
    failAck = true;
    session.update({
      elements: [element("a", 3, 200)],
      files: {},
      appState: {},
    });
    await assert.rejects(session.flush(), /ACK lost/);
    assert.equal(session.dirty, true);
    const committedSeq = room.seq;

    await session.checkpoint();
    unsubscribe();
    await session.dispose();
    session = new CollaborationSession(options);
    unsubscribe = session.subscribe(() => {});
    await session.start();
    await until(() => session.status === "ready" && !session.dirty);
    assert.equal(
      room.seq,
      committedSeq,
      "restored retry must use the original operation identity",
    );
    assert.equal(session.value.elements.length, 1);
    assert.equal((session.value.elements[0] as Element).x, 200);
    failAck = true;
    session.update({
      elements: [element("a", 4, 300)],
      files: {},
      appState: {},
    });
    await assert.rejects(session.flush(), /ACK lost/);
    await session.checkpoint();
    unsubscribe();
    await session.dispose();
    room.epoch = "restored-epoch";
    room.seq = 0;
    room.operations = {};
    room.clients = {};
    session = new CollaborationSession(options);
    unsubscribe = session.subscribe(() => {});
    await session.start();
    assert.equal(session.status, "recovery");
    assert.equal(session.editable, false);
    assert.equal(
      (session.value.elements[0] as Element).x,
      300,
      "old-epoch draft must remain downloadable after reload",
    );
    assert.equal(room.seq, 0, "an old epoch must never be silently replayed");
  } finally {
    unsubscribe();
    await session.dispose();
    closeCollaboration("owner", "test");
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("legacy adoption preserves remote additions and changes, persists before reload, and carries only the local delta", async () => {
  const originals = Object.fromEntries(
    ["navigator", "sessionStorage", "fetch"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const baseline = {
    elements: [element("a"), element("unchanged")],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
  const room = createRoom("legacy-adoption", "owner", "Canvas", "epoch", {
    elements: [element("a"), element("unchanged", 3, 99), element("remote")],
    appState: { viewBackgroundColor: "#abcdef" },
    files: {},
  });
  let posted: Operation | undefined;
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { configurable: true, value });

  define("navigator", {});
  define("sessionStorage", {
    getItem: () => "legacy-adoption-tab",
    setItem: () => {},
  });
  define("fetch", async (url: string, init: RequestInit) => {
    const path = url.split("/").at(-1);
    let command: Command;

    if (path === "access" || path === "view") command = { type: path };
    else if (path === "update") {
      posted = JSON.parse(String(init.body)) as Operation;
      command = {
        type: "update",
        operation: posted,
        digest: canonical(posted),
      };
    } else throw new Error(`Unexpected ${path}`);

    return Response.json(
      execute(room, { userId: "owner", name: "Owner" }, command, Date.now()),
    );
  });
  const options = {
    canvasId: room.id,
    userId: "owner",
    scope: "legacy-adoption",
  };
  let session = new CollaborationSession(options);

  try {
    await session.start(false);
    await assert.rejects(
      session.adoptLegacyDraft(baseline, baseline, "previous-epoch"),
      /已恢复/,
    );
    await session.adoptLegacyDraft(
      baseline,
      {
        ...baseline,
        elements: [
          element("a", 2, 50),
          element("unchanged"),
          element("local"),
          {
            ...element("never-shared-image"),
            type: "image",
            fileId: "pruned-local-file",
            isDeleted: true,
          },
        ],
        appState: { viewBackgroundColor: "#eeeeee" },
      },
      room.epoch,
    );
    assert.equal(session.dirty, true);
    assert.equal(session.value.elements.length, 4);
    assert.equal(
      (session.value.elements as Element[]).find(
        (item) => item.id === "unchanged",
      )?.x,
      99,
    );
    assert.equal(session.value.appState.viewBackgroundColor, "#abcdef");
    await session.dispose();
    session = new CollaborationSession(options);
    await session.start(false);
    assert.equal(session.dirty, true);
    await session.flush();
    assert.deepEqual(posted?.elements.map((item) => item.id).sort(), [
      "a",
      "local",
    ]);
    assert.equal(posted?.background, undefined);
    assert.equal(room.scene.elements.length, 4);
    assert.equal(
      room.scene.elements.find((item) => item.id === "unchanged")?.x,
      99,
    );
  } finally {
    await session.dispose();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("editing after a lost ACK keeps the attempted payload immutable, including after reload", async () => {
  const originalFetch = globalThis.fetch;
  let session: CollaborationSession | undefined;

  try {
    for (const reload of [false, true]) {
      const room = createRoom(
        `lost-ack-edit-${reload}`,
        "owner",
        "Canvas",
        "epoch",
        {
          elements: [],
          appState: {},
          files: {},
        },
      );
      const operations: Operation[] = [];
      let loseAck = true;

      globalThis.fetch = async (input, init) => {
        const path = String(input).split("/").at(-1);
        let command: Command;

        if (path === "access" || path === "view") command = { type: path };
        else if (path === "update") {
          const operation = JSON.parse(String(init?.body)) as Operation;

          operations.push(structuredClone(operation));
          command = { type: "update", operation, digest: canonical(operation) };
        } else throw new Error(`Unexpected ${path}`);
        const result = execute(
          room,
          { userId: "owner", name: "Owner" },
          command,
          Date.now(),
        );

        if (path === "update" && loseAck) {
          loseAck = false;
          throw new TypeError("ACK lost");
        }

        return Response.json(result);
      };

      const options = {
        canvasId: room.id,
        userId: "owner",
        scope: "lost-ack-edit",
      };

      session = new CollaborationSession(options);
      await session.start(false);
      session.update({ elements: [element("a")], appState: {}, files: {} });
      await assert.rejects(session.flush(), /ACK lost/);
      assert.equal(room.seq, 1);
      if (reload) {
        await session.checkpoint();
        await session.dispose();
        session = new CollaborationSession(options);
        await session.start(false);
      }

      session.update({
        elements: [element("a", 2, 100)],
        appState: {},
        files: {},
      });
      await session.flush();
      assert.equal(session.dirty, false);
      assert.equal(room.seq, 2);
      assert.equal(room.scene.elements[0]?.x, 100);
      assert.deepEqual(
        operations[1],
        operations[0],
        "retry must use exactly the originally attempted operation",
      );
      assert.notEqual(operations[2]?.opId, operations[0]?.opId);
      await session.dispose();
    }
  } finally {
    await session?.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("permission changes keep the previous editor draft discoverable without replaying across grants", async () => {
  const originalFetch = globalThis.fetch;
  const room = createRoom("draft-regrant", "owner", "Canvas", "epoch", {
    elements: [],
    appState: {},
    files: {},
  });
  const member = (role: "editor" | "viewer") =>
    execute(
      room,
      { userId: "owner", name: "Owner" },
      {
        type: "member",
        member: {
          id: crypto.randomUUID(),
          userId: "editor",
          name: "Editor",
          role,
          viewMode: "live",
        },
      },
      Date.now(),
    );
  let session: CollaborationSession | undefined;
  let posts = 0;
  let offline = true;

  member("editor");
  globalThis.fetch = async (input, init) => {
    const path = String(input).split("/").at(-1);

    if (path === "update") {
      posts++;
      if (offline) throw new TypeError("offline");
      const operation = JSON.parse(String(init?.body)) as Operation;

      return Response.json(
        execute(
          room,
          { userId: "editor", name: "Editor" },
          {
            type: "update",
            operation,
            digest: canonical(operation),
          },
          Date.now(),
        ),
      );
    }

    if (path !== "access" && path !== "view")
      throw new Error(`Unexpected ${path}`);

    return Response.json(
      execute(
        room,
        { userId: "editor", name: "Editor" },
        { type: path },
        Date.now(),
      ),
    );
  };

  const options = {
    canvasId: room.id,
    userId: "editor",
    scope: "draft-regrant",
  };

  try {
    session = new CollaborationSession(options);
    await session.start(false);
    session.update({
      elements: [element("a", 2, 99)],
      appState: {},
      files: {},
    });
    await assert.rejects(session.flush(), /offline/);
    await session.checkpoint();
    await session.dispose();
    for (const role of ["viewer", "editor"] as const) {
      member(role);
      session = new CollaborationSession(options);
      await session.start(false);
      assert.equal(session.status, "recovery");
      assert.equal(session.editable, false);
      assert.equal(session.dirty, true);
      assert.equal(
        (session.value.elements[0] as Element).x,
        99,
        "the backup action must still contain the old local draft",
      );
      await assert.rejects(session.flush(), /权限变更前/);
      assert.equal(
        posts,
        1,
        "old-grant operations must never be sent under a new grant",
      );
      assert.equal(room.seq, 0);
      assert.equal(await session.discardDraft(false), false);
      assert.equal(
        session.dirty,
        true,
        "cancelling must preserve the old queue",
      );
      await session.dispose();
    }

    // Reopen once more to prove cancelling did not remove the persisted backup.
    session = new CollaborationSession(options);
    await session.start(false);
    assert.equal(session.status, "recovery");
    offline = false;
    const authorize = globalThis.fetch;
    let release!: () => void;
    const authorization = new Promise<void>((resolve) => {
      release = resolve;
    });

    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/access")) await authorization;

      return authorize(input, init);
    };

    const discarding = session.discardDraft(true);

    assert.equal(
      session.editable,
      false,
      "discard keeps the selected queue read-only until reauthorization",
    );
    assert.equal(
      session.update({
        elements: [element("unapproved")],
        appState: {},
        files: {},
      }),
      undefined,
    );
    assert.equal(
      await session.discardDraft(true),
      false,
      "repeated clicks must not start another discard",
    );
    await Promise.all([
      session.checkpoint(),
      session.flush(),
      session.start(false),
    ]);
    assert.equal(
      session.dirty,
      true,
      "background work must not replace the selected queue during discard",
    );
    release();
    assert.equal(await discarding, true);
    globalThis.fetch = authorize;
    assert.equal(session.status, "ready");
    assert.equal(session.dirty, false);
    assert.equal(
      session.value.elements.length,
      0,
      "discard loads current cloud content",
    );
    assert.equal(
      posts,
      1,
      "discard never replays the previous authorization's queue",
    );
    session.update({ elements: [element("new")], appState: {}, files: {} });
    await session.flush();
    assert.equal(room.seq, 1);
    assert.deepEqual(
      room.scene.elements.map((item) => item.id),
      ["new"],
    );
  } finally {
    await session?.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("draft recovery discovery stays within the current account, canvas and tab", async () => {
  const key = (user: string, canvas: string, grant: string, tab: string) =>
    `${JSON.stringify([1, user, canvas, grant, "editor", "live", ""])}:tab:${tab}`;
  const current = key("isolation-user", "isolation-canvas", "current", "tab");
  const draft: Draft = {
    clientId: "client",
    clientSeq: 1,
    operations: [
      {
        protocolVersion: 1,
        epoch: "epoch",
        clientId: "client",
        clientSeq: 1,
        opId: "operation",
        baseSeq: 0,
        elements: [element("a")],
      },
    ],
    files: {},
    updatedAt: new Date().toISOString(),
  };

  for (const unrelated of [
    key("other-user", "isolation-canvas", "old", "tab"),
    key("isolation-user", "other-canvas", "old", "tab"),
    key("isolation-user", "isolation-canvas", "old", "other-tab"),
  ])
    await draftStorage(unrelated, "put", draft);
  assert.equal(await findRecoveryDraft(current), undefined);
  const previous = key("isolation-user", "isolation-canvas", "old", "tab");

  await draftStorage(previous, "put", draft);
  assert.equal((await findRecoveryDraft(current))?.key, previous);
  await draftStorage(previous, "put", { ...draft, operations: [] });
  assert.equal(await findRecoveryDraft(current), undefined);
});

test("an existing room unlocks on HTTP confirmation while presence is delayed, and saving needs no WS READY", async () => {
  const names = [
    "navigator",
    "sessionStorage",
    "location",
    "WebSocket",
    "fetch",
    "window",
    "document",
  ];
  const originals = new Map(
    names.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const room = createRoom("solo-http-test", "owner", "Solo", "epoch", {
    elements: [],
    appState: {},
    files: {},
  });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let presenceEntered = false;
  let tickets = 0;
  let failAccess = false;
  let slowSave = false;
  let saveEntered = false;
  let releaseSave!: () => void;
  const saveWaiting = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true });

  class NoReadySocket extends Socket {
    send() {}
  }

  define("navigator", {});
  define("sessionStorage", {
    getItem: () => "solo-presence-test",
    setItem() {},
  });
  define("location", { origin: "https://solo.test" });
  define("WebSocket", NoReadySocket);
  const page = new EventTarget();

  define("window", page);
  define(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  define("fetch", async (url: string, init: RequestInit) => {
    const path = url.split("/").at(-1);

    if (path === "access" && failAccess) {
      failAccess = false;
      throw new Error("temporary resume network failure");
    }

    if (path === "presence") {
      if (!JSON.parse(String(init.body)).leave) {
        presenceEntered = true;
        await waiting;
      }

      return Response.json({
        participants: 2,
        realtime: true,
        leaseExpiresAt: 123456,
      });
    }

    if (path === "ticket") {
      tickets++;

      return Response.json({ ticket: "no-ready" });
    }

    const command: Command =
      path === "update"
        ? {
            type: "update",
            operation: JSON.parse(String(init.body)),
            digest: canonical(JSON.parse(String(init.body))),
          }
        : { type: path as "access" | "view" };

    const result = execute(
      room,
      { userId: "owner", name: "Owner" },
      command,
      Date.now(),
    );

    if (path === "update" && slowSave) {
      slowSave = false;
      saveEntered = true;
      await saveWaiting;
    }

    return Response.json(result);
  });
  const session = new CollaborationSession({
    canvasId: room.id,
    userId: "owner",
    scope: "solo-presence",
  });
  const unsubscribe = session.subscribe(() => {});

  try {
    await session.start();
    await until(() => presenceEntered);
    assert.equal(session.editable, true);
    assert.equal(
      tickets,
      0,
      "slow presence does not block editing or create an eager WS",
    );
    session.update({ elements: [element("a")], appState: {}, files: {} });
    await session.flush();
    assert.equal(session.statusText, "已保存");
    assert.equal(room.scene.elements.length, 1);
    slowSave = true;
    session.update({
      elements: [element("a", 2, 25)],
      appState: {},
      files: {},
    });
    const savingAcrossSuspend = session.flush();

    await until(() => saveEntered);
    // bfcache may suspend while both the first lease and an ACK are pending.
    page.dispatchEvent(new Event("pagehide"));
    failAccess = true;
    page.dispatchEvent(new Event("pageshow"));
    await until(() => session.status === "offline");
    page.dispatchEvent(new Event("online"));
    await until(() => session.editable && session.status === "ready");
    assert.equal(session.value.elements.length, 1);
    assert.equal(
      session.dirty,
      true,
      "resume must preserve the in-flight queue until its ACK",
    );
    assert.equal((session.value.elements[0] as Element).x, 25);
    releaseSave();
    await savingAcrossSuspend;
    release();
    await until(() => tickets === 1);
    assert.equal(
      session.editable,
      true,
      "a missing AUTH READY cannot freeze a confirmed HTTP editor",
    );
    session.update({
      elements: [element("a", 3, 50)],
      appState: {},
      files: {},
    });
    await session.flush();
    assert.equal(session.statusText, "已保存");
    assert.equal(room.scene.elements[0]!.x, 50);
    Socket.instances.at(-1)!.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "ERROR", message: "连接凭证已过期" }),
      }),
    );
    await until(
      () =>
        session.realtimeStatus === "unavailable" && session.status === "ready",
    );
    assert.equal(
      session.editable,
      true,
      "a WS authentication error must verify HTTP authority instead of permanently denying edits",
    );
    session.update({
      elements: [element("a", 4, 75)],
      appState: {},
      files: {},
    });
    await session.flush();
    assert.equal(room.scene.elements[0]!.x, 75);
    assert.match(session.statusText, /^已保存/);
  } finally {
    releaseSave();
    release();
    unsubscribe();
    await session.dispose();
    await setImmediate();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("owner/share remounts serialize a delayed old touch before the new lease and never delete its participation", async () => {
  const names = ["navigator", "sessionStorage", "fetch"];
  const originals = new Map(
    names.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const room = createRoom("scope-lease-test", "owner", "Scope", "epoch", {
    elements: [],
    appState: {},
    files: {},
  });
  let lease: number | undefined;
  let touches = 0;
  let entered = false;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true });

  define("navigator", {});
  define("sessionStorage", { getItem: () => "scope-lease-test", setItem() {} });
  define("fetch", async (url: string, init: RequestInit) => {
    const path = url.split("/").at(-1);

    if (path === "presence") {
      const data = JSON.parse(String(init.body));

      if (data.leave) {
        if (data.leaseExpiresAt !== undefined && data.leaseExpiresAt === lease)
          lease = undefined;
      } else {
        touches++;
        if (touches === 1) {
          entered = true;
          await waiting;
        }

        lease = Math.max(Date.now() + 150000, (lease ?? 0) + 1);
      }

      return Response.json({
        participants: lease ? 1 : 0,
        realtime: false,
        leaseExpiresAt: lease,
      });
    }

    return Response.json(
      execute(
        room,
        { userId: "owner", name: "Owner" },
        { type: path as "access" | "view" },
        Date.now(),
      ),
    );
  });
  const old = new CollaborationSession({
    canvasId: room.id,
    userId: "owner",
    scope: "account",
  });
  const next = new CollaborationSession({
    canvasId: room.id,
    userId: "owner",
    scope: "public:new-scope",
  });
  const unsubscribeOld = old.subscribe(() => {});
  let unsubscribeNext = () => {};

  try {
    await old.start();
    await until(() => entered);
    unsubscribeOld();
    unsubscribeNext = next.subscribe(() => {});
    await next.start();
    assert.equal(
      next.editable,
      true,
      "a prior scope lease never blocks the new HTTP editor",
    );
    assert.equal(
      touches,
      1,
      "the second scope waits behind the old touch at the transport boundary",
    );
    release();
    await until(
      () => touches === 2 && next.participants === 1 && lease !== undefined,
    );
    await setImmediate();
    assert.notEqual(
      lease,
      undefined,
      "late old touch/leave cannot erase the current scope lease",
    );
    assert.equal(next.editable, true);
  } finally {
    release();
    unsubscribeOld();
    unsubscribeNext();
    await old.dispose();
    await next.dispose();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

async function handshakeFixture(socket: typeof Socket = Socket) {
  const names = [
    "navigator",
    "sessionStorage",
    "location",
    "WebSocket",
    "fetch",
    "window",
    "document",
  ];
  const originals = new Map(
    names.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const room = createRoom(crypto.randomUUID(), "owner", "Handshake", "epoch", {
    elements: [],
    appState: {},
    files: {},
  });
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true });
  const signals = new Map<string, AbortSignal | null | undefined>();
  const calls = new Map<string, number>();
  let intercept:
    | ((path: string, init: RequestInit) => Promise<Response> | undefined)
    | undefined;

  define("navigator", {});
  define("sessionStorage", { getItem: () => room.id, setItem() {} });
  define("location", { origin: "https://handshake.test" });
  define("WebSocket", socket);
  define("window", new EventTarget());
  define(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  define("fetch", async (url: string, init: RequestInit) => {
    const path = url.split("/").at(-1)!;

    signals.set(path, init.signal);
    calls.set(path, (calls.get(path) ?? 0) + 1);
    const response = intercept?.(path, init);

    if (response) return response;
    if (path === "ticket") return Response.json({ ticket: "secret-ticket" });
    if (path === "presence")
      return Response.json({
        participants: 2,
        realtime: true,
        leaseExpiresAt: Date.now() + 60000,
      });
    const command: Command =
      path === "update"
        ? {
            type: "update",
            operation: JSON.parse(String(init.body)),
            digest: canonical(JSON.parse(String(init.body))),
          }
        : { type: path as "access" | "view" };

    return Response.json(
      execute(room, { userId: "owner", name: "Owner" }, command, Date.now()),
    );
  });
  const session = new CollaborationSession({
    canvasId: room.id,
    userId: "owner",
    scope: room.id,
  });
  const unsubscribe = session.subscribe(() => {});

  return {
    session,
    room,
    signals,
    calls,
    unsubscribe,
    intercept(value: typeof intercept) {
      intercept = value;
    },
    async cleanup() {
      unsubscribe();
      await session.dispose();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("OPEN without READY times out, retries with a fresh ticket, ignores old callbacks, and preserves HTTP saving", async (t) => {
  class SilentSocket extends Socket {
    send() {}
  }

  const fixture = await handshakeFixture(SilentSocket);
  const { session, room, calls } = fixture;
  const warnings: unknown[][] = [];

  t.mock.method(console, "warn", (...values: unknown[]) =>
    warnings.push(values),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await session.start();
    await until(() => session.realtimeStatus === "connecting");
    t.mock.timers.tick(0);
    await until(() => session.connectionDiagnostic?.stage === "ready");
    const staleMessage = (
      session as unknown as {
        socket: { onmessage(event: MessageEvent): void };
      }
    ).socket.onmessage;

    t.mock.timers.tick(10_001);
    assert.equal(session.realtimeStatus, "unavailable");
    assert.deepEqual(
      { ...session.connectionDiagnostic, at: 0 },
      { stage: "ready", state: "failed", reason: "timeout", at: 0 },
    );
    assert.equal(session.editable, true);
    session.update({ elements: [element("a")], appState: {}, files: {} });
    await session.flush();
    assert.equal(room.scene.elements.length, 1);
    assert.equal(fixture.signals.get("update"), undefined);
    t.mock.timers.tick(1001);
    await until(() => session.realtimeStatus === "connecting");
    t.mock.timers.tick(0);
    await until(() => calls.get("ticket") === 2);
    await until(() => session.connectionDiagnostic?.stage === "ready");
    staleMessage(
      new MessageEvent("message", { data: JSON.stringify({ type: "READY" }) }),
    );
    await setImmediate();
    assert.equal(session.realtimeStatus, "connecting");
    assert.equal(calls.get("view"), 1);
    const diagnostic = session.connectionDiagnostic;

    fixture.unsubscribe();
    t.mock.timers.tick(60_000);
    await setImmediate();
    assert.equal(calls.get("ticket"), 2);
    assert.deepEqual(session.connectionDiagnostic, diagnostic);
    fixture.session.dispose();
    t.mock.timers.tick(60_000);
    assert.equal(calls.get("ticket"), 2);
    assert.doesNotMatch(
      JSON.stringify(warnings),
      /secret-ticket|owner|epoch|scene/,
    );
  } finally {
    await fixture.cleanup();
    t.mock.timers.reset();
  }
});

test("access and ticket deadlines abort stalled HTTP before Upgrade and view has a longer deadline", async (t) => {
  const fixture = await handshakeFixture();
  const { session } = fixture;
  const deadlines: number[] = [];
  const actualTimeout = AbortSignal.timeout.bind(AbortSignal);

  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    deadlines.push(milliseconds);

    return actualTimeout(5);
  });
  t.mock.method(console, "warn", () => {});
  fixture.intercept((_path, init) => {
    if (!init.signal) return undefined;

    return new Promise((_resolve, reject) => {
      init.signal!.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
        {
          once: true,
        },
      );
    });
  });
  try {
    // Keep the event loop alive while Node's AbortSignal timeout is unref'ed.
    const alive = setInterval(() => {}, 1000);

    try {
      for (const path of ["access", "ticket", "view"]) {
        await assert.rejects(session.request(path), { name: "TimeoutError" });
        assert.equal(session.connectionDiagnostic?.stage, path);
        assert.equal(session.connectionDiagnostic?.reason, "timeout");
      }
    } finally {
      clearInterval(alive);
    }

    assert.deepEqual(deadlines, [10_000, 10_000, 120_000]);
    fixture.intercept(undefined);
    await session.start();
    await until(() => session.realtimeStatus === "connected");
    assert.equal(session.editable, true);
  } finally {
    await fixture.cleanup();
  }
});

test("READY still waits for the authoritative view, whose timeout is diagnosed and retried", async (t) => {
  const fixture = await handshakeFixture();
  const { session } = fixture;
  const actualTimeout = AbortSignal.timeout.bind(AbortSignal);
  let failReadyView = true;

  t.mock.method(console, "warn", () => {});
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) =>
    actualTimeout(milliseconds === 120_000 ? 30 : milliseconds),
  );
  fixture.intercept((path, init) => {
    if (path !== "view" || fixture.calls.get("view") !== 2 || !failReadyView)
      return undefined;

    const body = new ReadableStream({
      start(controller) {
        init.signal!.addEventListener(
          "abort",
          () => controller.error(init.signal!.reason),
          { once: true },
        );
      },
    });

    return Promise.resolve(new Response(body, { status: 200 }));
  });
  try {
    await session.start();
    await until(() => session.connectionDiagnostic?.stage === "ready-view");
    assert.notEqual(session.realtimeStatus, "connected");
    await until(() => session.connectionDiagnostic?.reason === "timeout");
    assert.equal(session.connectionDiagnostic?.stage, "ready-view");
    assert.equal(session.realtimeStatus, "unavailable");
    assert.equal(session.status, "offline");
    failReadyView = false;
    await until(() => session.realtimeStatus === "connected");
    assert.equal(session.status, "ready");
  } finally {
    await fixture.cleanup();
  }
});

for (const phase of ["access", "ticket"] as const)
  test(`stalled ${phase} during URL preparation aborts before Upgrade and reconnects`, async (t) => {
    const fixture = await handshakeFixture();
    const { session } = fixture;
    const originalInstances = Socket.instances.length;
    const actualTimeout = AbortSignal.timeout.bind(AbortSignal);
    let stalled = false;

    t.mock.method(console, "warn", () => {});
    t.mock.method(AbortSignal, "timeout", (milliseconds: number) =>
      actualTimeout(milliseconds === 10_000 ? 10 : milliseconds),
    );
    fixture.intercept((path, init) => {
      if (
        stalled ||
        path !== phase ||
        (phase === "access" && fixture.calls.get("access") === 1)
      )
        return undefined;
      stalled = true;

      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => reject(init.signal!.reason),
          { once: true },
        );
      });
    });
    try {
      await session.start();
      await until(() => session.connectionDiagnostic?.reason === "timeout");
      assert.equal(session.connectionDiagnostic?.stage, phase);
      assert.equal(Socket.instances.length, originalInstances);
      assert.equal(session.editable, true);
      await until(() => session.realtimeStatus === "connected");
      assert.equal(session.connectionDiagnostic?.state, "complete");
      assert.equal(Socket.instances.length, originalInstances + 1);
    } finally {
      await fixture.cleanup();
    }
  });

test("HTTP denial during the READY view still closes the editor", async (t) => {
  const fixture = await handshakeFixture();
  const { session } = fixture;

  t.mock.method(console, "warn", () => {});
  fixture.intercept((path) => {
    if (path !== "view" || fixture.calls.get("view") !== 2) return undefined;

    return Promise.resolve(
      Response.json(
        { error: { code: "ACCESS_CHANGED", message: "权限已撤销" } },
        { status: 403 },
      ),
    );
  });
  try {
    await session.start();
    await until(() => session.status === "denied");
    assert.equal(session.editable, false);
    assert.notEqual(session.realtimeStatus, "connected");
  } finally {
    await fixture.cleanup();
  }
});

test("a late READY view cannot resurrect a socket closed while the view was loading", async (t) => {
  const fixture = await handshakeFixture();
  const { session, room } = fixture;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });

  t.mock.method(console, "warn", () => {});
  fixture.intercept((path) => {
    if (path !== "view" || fixture.calls.get("view") !== 2) return undefined;

    return waiting.then(() =>
      Response.json(
        execute(
          room,
          { userId: "owner", name: "Owner" },
          { type: "view" },
          Date.now(),
        ),
      ),
    );
  });
  try {
    await session.start();
    await until(() => session.connectionDiagnostic?.stage === "ready-view");
    Socket.instances.at(-1)!.close();
    assert.equal(session.realtimeStatus, "unavailable");
    release();
    await setImmediate();
    assert.notEqual(session.realtimeStatus, "connected");
    assert.notEqual(session.connectionDiagnostic?.state, "complete");
    await until(() => session.realtimeStatus === "connected");
    assert.equal(session.editable, true);
  } finally {
    release();
    await fixture.cleanup();
  }
});

test("known HTTP denial stays authoritative when its response body times out", async (t) => {
  const fixture = await handshakeFixture();
  const { session } = fixture;
  const actualTimeout = AbortSignal.timeout.bind(AbortSignal);

  t.mock.method(console, "warn", () => {});
  try {
    await session.start();
    await until(() => session.realtimeStatus === "connected");
    t.mock.method(AbortSignal, "timeout", () => actualTimeout(10));
    fixture.intercept((path, init) => {
      if (path !== "access") return undefined;
      const body = new ReadableStream({
        start(controller) {
          init.signal!.addEventListener(
            "abort",
            () => controller.error(init.signal!.reason),
            { once: true },
          );
        },
      });

      return Promise.resolve(new Response(body, { status: 403 }));
    });
    window.dispatchEvent(new Event("online"));
    await until(() => session.status === "denied");
    assert.equal(session.editable, false);
    assert.notEqual(session.connectionDiagnostic?.reason, "timeout");
  } finally {
    await fixture.cleanup();
  }
});

test("a ticket network failure is diagnosed before Upgrade rather than blamed on WebSocket", async (t) => {
  const fixture = await handshakeFixture();
  const { session } = fixture;
  const instances = Socket.instances.length;

  t.mock.method(console, "warn", () => {});
  fixture.intercept((path) => {
    if (path !== "ticket" || fixture.calls.get("ticket") !== 1)
      return undefined;

    return Promise.reject(new TypeError("Failed to fetch"));
  });
  try {
    await session.start();
    await until(() => session.connectionDiagnostic?.state === "failed");
    assert.equal(session.connectionDiagnostic?.stage, "ticket");
    assert.equal(session.connectionDiagnostic?.reason, "transport");
    assert.equal(Socket.instances.length, instances);
    assert.equal(session.editable, true);
    await until(() => session.realtimeStatus === "connected");
  } finally {
    await fixture.cleanup();
  }
});

test("a late view after WS ERROR cannot undo a concurrent authoritative HTTP denial", async (t) => {
  const fixture = await handshakeFixture();
  const { session, room } = fixture;
  let deny = false;
  let entered = false;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });

  t.mock.method(console, "warn", () => {});
  try {
    await session.start();
    await until(() => session.realtimeStatus === "connected");
    fixture.intercept((path) => {
      if (path === "access" && deny)
        return Promise.resolve(
          Response.json(
            { error: { code: "ACCESS_CHANGED", message: "权限已撤销" } },
            { status: 403 },
          ),
        );
      if (path !== "view") return undefined;
      entered = true;

      return waiting.then(() =>
        Response.json(
          execute(
            room,
            { userId: "owner", name: "Owner" },
            { type: "view" },
            Date.now(),
          ),
        ),
      );
    });
    Socket.instances.at(-1)!.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "ERROR", message: "票据失效" }),
      }),
    );
    await until(() => entered);
    deny = true;
    window.dispatchEvent(new Event("online"));
    await until(() => session.status === "denied");
    release();
    await setImmediate();
    assert.equal(session.status, "denied");
    assert.equal(session.editable, false);
  } finally {
    release();
    await fixture.cleanup();
  }
});
