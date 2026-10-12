import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRoom,
  execute,
  authorize,
  type Command,
} from "../../shared/collaboration/room";
import {
  canonical,
  CollaborationError,
} from "../../shared/collaboration/merge";
import type {
  Element,
  Principal,
  RoomState,
  Operation,
  CanvasView,
  Commit,
} from "../../shared/collaboration/types";

const owner: Principal = { userId: "owner", name: "Owner" };
const now = 2000000;
const element = (
  id: string,
  version = 1,
  versionNonce = 20,
  extra = {},
): Element => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  angle: 0,
  index: "a0",
  version,
  versionNonce,
  isDeleted: false,
  ...extra,
});
const room = () =>
  createRoom("canvas", "owner", "Canvas", "epoch", {
    elements: [],
    appState: {},
    files: {},
  });
const run = <T = unknown>(
  state: RoomState,
  command: Command,
  actor = owner,
): T => execute(state, actor, command, now) as T;
const update = (
  state: RoomState,
  elements: Element[],
  overrides: Partial<Operation> = {},
  actor = owner,
) => {
  const operation: Operation = {
    protocolVersion: 1,
    epoch: "epoch",
    clientId: "client",
    clientSeq: state.seq + 1,
    opId: `op-${state.seq}`,
    baseSeq: state.seq,
    elements,
    ...overrides,
  };

  return run<Commit>(
    state,
    { type: "update", operation, digest: canonical(operation) },
    actor,
  );
};
const publish = (state: RoomState, id: string, label = "First") =>
  run(state, {
    type: "publish",
    id,
    label,
    snapshot: {
      sceneKey: `snapshot-${id}`,
      epoch: state.epoch,
      seq: state.seq,
      name: state.name,
      files: structuredClone(state.scene.files),
    },
  });
const error = (code: string) => (value: unknown) =>
  value instanceof CollaborationError && value.code === code;

function link(
  state: RoomState,
  id: string,
  role: "viewer" | "editor",
  viewMode: "live" | "latest" | "fixed",
  snapshotId?: string,
) {
  run(state, {
    type: "link",
    link: {
      id,
      role,
      viewMode,
      snapshotId,
      secretHash: id,
      requireLogin: false,
      expiresAt: null,
    },
  });
  run(
    state,
    {
      type: "exchange",
      secretHash: id,
      capabilityHash: `cap-${id}`,
      guestId: id,
    },
    { name: "" },
  );

  return { name: "", capabilityHash: `cap-${id}` };
}

test("independent stale-base edits converge, including same-account sessions", () => {
  const state = room();

  update(state, [element("a")]);
  update(state, [element("b")], {
    clientId: "second",
    clientSeq: 1,
    baseSeq: 0,
  });
  assert.deepEqual(
    state.scene.elements.map((item) => item.id),
    ["a", "b"],
  );
});

test("same-element version/nonce and deletion races converge independent of arrival", () => {
  const edits = [
    element("a", 2, 50, { x: 10 }),
    element("a", 2, 10, { isDeleted: true }),
  ];
  const left = room(),
    right = room();

  for (const value of edits) update(left, [value]);
  for (const value of [...edits].reverse()) update(right, [value]);
  assert.deepEqual(left.scene, right.scene);
  assert.equal(left.scene.elements[0]?.isDeleted, true);
  update(left, [element("a", 3, 30, { isDeleted: false, x: 50 })]);
  assert.equal(left.scene.elements[0]?.isDeleted, false);
});

test("durable operation identity is idempotent and rejects payload/principal reuse", () => {
  const state = room();
  const op: Operation = {
    protocolVersion: 1,
    epoch: "epoch",
    clientId: "client",
    clientSeq: 1,
    opId: "stable",
    baseSeq: 0,
    elements: [element("a")],
  };
  const command: Command = {
    type: "update",
    operation: op,
    digest: canonical(op),
  };
  const first = run(state, command);

  const replay = run<Commit>(state, command);

  assert.equal(replay.seq, (first as Commit).seq);
  assert.equal(replay.replayed, true);
  assert.equal(state.seq, 1);
  state.minMergeSeq = state.seq;
  assert.equal(
    run<Commit>(state, command).replayed,
    true,
    "retained receipts still acknowledge retries whose original base aged out",
  );
  assert.throws(
    () => run(state, { ...command, digest: "different" }),
    error("OPERATION_REUSED"),
  );
  assert.throws(
    () => update(state, [element("a", 1, 20, { x: 5 })]),
    error("ELEMENT_VERSION_REUSED"),
  );
});

test("live/latest/fixed grants enforce server modes and fixed links do not inherit owner rights", () => {
  const state = room();

  update(state, [element("a")]);
  publish(state, "v1");
  const latest = link(state, "latest", "viewer", "latest");
  const fixed = link(state, "fixed", "viewer", "fixed", "v1");
  const live = link(state, "live", "viewer", "live");
  const firstLatest = run<CanvasView>(state, { type: "view" }, latest);

  update(state, [element("b")]);
  assert.equal(firstLatest.scene.elements.length, 1);
  assert.equal(
    run<CanvasView>(state, { type: "view" }, latest).scene.elements.length,
    2,
  );
  assert.equal(
    run<CanvasView>(state, { type: "view" }, fixed).snapshot?.seq,
    1,
  );
  assert.equal(
    run<CanvasView>(state, { type: "view" }, live).scene.elements.length,
    2,
  );
  assert.throws(
    () => run(state, { type: "ticket", hash: "x" }, fixed),
    error("LIVE_ACCESS_REQUIRED"),
  );
  assert.throws(
    () => run(state, { type: "ticket", hash: "x" }, latest),
    error("LIVE_ACCESS_REQUIRED"),
  );
  assert.throws(
    () => update(state, [element("c")], {}, live),
    error("READ_ONLY"),
  );
  run(
    state,
    {
      type: "exchange",
      secretHash: "fixed",
      capabilityHash: "owner-fixed",
      guestId: "unused",
    },
    owner,
  );
  const narrowed = { ...owner, capabilityHash: "owner-fixed" };

  assert.equal(authorize(state, narrowed, now).role, "viewer");
  assert.throws(
    () => run(state, { type: "manage" }, narrowed),
    error("OWNER_REQUIRED"),
  );
});

test("fixed versions pin scene, name, and images and publishing retries preserve the original watermark", () => {
  const state = room();

  run(state, {
    type: "asset",
    file: {
      id: "file",
      objectKey: "immutable",
      mimeType: "image/png",
      created: 1,
    },
  });
  update(state, [element("image", 1, 20, { type: "image", fileId: "file" })]);
  publish(state, "v1");
  update(state, [
    element("image", 2, 30, { type: "image", fileId: "file", isDeleted: true }),
  ]);
  run(state, { type: "rename", name: "New name" });
  assert.deepEqual(publish(state, "v1", "Retry"), { id: "v1", seq: 1 });
  const fixed = link(state, "fixed", "viewer", "fixed", "v1");
  const result = run<CanvasView>(state, { type: "view" }, fixed);

  assert.equal(result.name, "Canvas");
  assert.equal(result.snapshot?.seq, 1);
  assert.equal(result.scene.files.file?.objectKey, "immutable");
  run(state, { type: "removeVersion", id: "v1" });
  assert.throws(
    () => run(state, { type: "view" }, fixed),
    error("VERSION_UNAVAILABLE"),
  );
});

test("revocation, login-bound capabilities, expired links and deletion invalidate access", () => {
  const state = room();
  const editor = link(state, "edit", "editor", "live");

  update(state, [element("a")], {}, editor);
  assert.throws(
    () => run(state, { type: "view" }, { ...editor, userId: "different" }),
    error("ACCESS_REVOKED"),
  );
  run(state, { type: "removeLink", id: "edit" });
  assert.throws(
    () => update(state, [element("b")], {}, editor),
    error("ACCESS_REVOKED"),
  );
  run(state, { type: "delete" });
  assert.throws(() => run(state, { type: "view" }), error("CANVAS_DELETED"));
});

test("join tickets are one use, short-lived, and permissions are checked again at consumption", () => {
  const state = room();
  const editor = link(state, "edit", "editor", "live");

  run(state, { type: "ticket", hash: "ticket" }, editor);
  assert.ok(run(state, { type: "authenticate", hash: "ticket" }, { name: "" }));
  assert.throws(
    () => run(state, { type: "authenticate", hash: "ticket" }),
    error("INVALID_TICKET"),
  );
  run(state, { type: "ticket", hash: "revoked" }, editor);
  run(state, { type: "removeLink", id: "edit" });
  assert.throws(
    () => run(state, { type: "authenticate", hash: "revoked" }),
    error("ACCESS_REVOKED"),
  );
});

test("expired offline bases cannot resurrect tombstones and missing images cannot be saved", () => {
  const state = room();

  state.minMergeSeq = 1;
  state.seq = 1;
  assert.throws(
    () => update(state, [element("a")], { baseSeq: 0 }),
    error("DRAFT_RECOVERY_REQUIRED"),
  );
  assert.throws(
    () => update(state, [element("a")], { epoch: "old" }),
    error("DRAFT_RECOVERY_REQUIRED"),
  );
  assert.throws(
    () =>
      update(state, [
        element("image", 1, 20, { type: "image", fileId: "missing" }),
      ]),
    error("ASSET_NOT_READY"),
  );
});

test("only shared background is synchronized, and simultaneous background updates use a precondition", () => {
  const state = room();

  update(state, [], { background: { value: "#ffffff", base: null } });
  const result = update(state, [], {
    background: { value: "#000000", base: null },
  });

  assert.deepEqual(result.skipped, ["viewBackgroundColor"]);
  assert.equal(state.scene.appState.viewBackgroundColor, "#ffffff");
});

test("compensating undo checks its element version in the durable transaction", () => {
  const state = room();

  update(state, [element("a")]);
  update(state, [element("a", 2, 10, { x: 200 })]);
  const result = update(state, [element("a", 3, 5, { isDeleted: true })], {
    preconditions: { a: { version: 1, versionNonce: 20 } },
  });

  assert.deepEqual(result.skipped, ["a"]);
  assert.equal(state.scene.elements[0]?.isDeleted, false);
  assert.equal(state.scene.elements[0]?.x, 200);
});

test("ordering repairs and bound text/arrow references produce portable canonical elements", () => {
  const state = room();
  const container = element("container", 1, 10, {
    boundElements: [
      { id: "label", type: "text" },
      { id: "arrow", type: "arrow" },
    ],
  });
  const label = element("label", 1, 11, {
    type: "text",
    text: "Bound text",
    containerId: "container",
    index: "a1",
  });
  const arrow = element("arrow", 1, 12, {
    type: "arrow",
    points: [
      [0, 0],
      [100, 100],
    ],
    startBinding: { elementId: "container" },
    index: "a2",
  });

  update(state, [container, label, arrow]);
  const result = update(state, [element("another", 1, 13)]);

  assert.equal(
    new Set(state.scene.elements.map((element) => element.index)).size,
    4,
  );
  assert.equal(
    state.scene.elements.find((element) => element.id === "label")?.containerId,
    "container",
  );
  assert.deepEqual(
    state.scene.elements.find((element) => element.id === "arrow")
      ?.startBinding,
    { elementId: "container" },
  );
  assert.ok(result.elements.some((element) => element.versionNonce === 0));
});
