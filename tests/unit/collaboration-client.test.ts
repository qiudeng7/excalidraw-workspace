import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import { CollaborationSession } from "../../src/lib/collaboration/session";
import {
  createRoom,
  execute,
  type Command,
} from "../../shared/collaboration/room";
import { canonical } from "../../shared/collaboration/merge";
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
  let session = new CollaborationSession(options);
  let unsubscribe = session.subscribe(() => {});

  try {
    await session.start();
    await until(() => session.status === "ready");
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
    session.update({
      elements: [element("a", 2, 100)],
      files: {},
      appState: {},
    });
    delayAck = false;
    release!();
    await saving;
    assert.equal(session.dirty, false);
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
    session.dispose();
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
    session.dispose();
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
    session.dispose();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
