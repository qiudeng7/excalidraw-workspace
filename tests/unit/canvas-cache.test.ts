import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CanvasResources } from "../../src/lib/canvasResources";
import {
  ConfirmedCache,
  cacheKey,
  type CacheDisk,
  type CacheEntry,
} from "../../src/lib/confirmedCache";
import { PersistentResource } from "../../src/lib/persistence";
import { useCanvasDocument } from "../../src/composables/useCanvasDocument";
import { useWorkspaceNavigation } from "../../src/composables/useWorkspaceNavigation";
import { ApiError, conditionalApi } from "../../src/lib/api";
import type { CanvasDocument, CanvasScene } from "../../shared/contracts";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {},
});
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: { getItem: () => "test-cache-tab", setItem: () => {} },
});
const scene = (label: string): CanvasScene => ({
  elements: [{ id: label }],
  appState: {},
  files: {},
});
const canvas = (id: string, revision = 0, label = id): CanvasDocument => ({
  id,
  name: id,
  position: 0,
  workspaceId: "space",
  revision,
  updatedAt: `version-${revision}`,
  createdAt: "created",
  scene: scene(label),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

function cache() {
  const entries = new Map<string, CacheEntry>();
  const disk: CacheDisk = {
    read: async (key) => entries.get(key),
    write: async (entry) => {
      const previous = entries.get(entry.key);

      if (
        !previous ||
        (previous.revisionScope ?? "") !== (entry.revisionScope ?? "") ||
        previous.revision <= entry.revision
      )
        entries.set(entry.key, structuredClone(entry));
    },
    remove: async (key) => {
      entries.delete(key);
    },
  };

  return { cache: new ConfirmedCache(disk), entries, disk };
}

const library = async () => ({ items: [], revision: 0 });

test(
  "a cached legacy revision cannot keep a migrated canvas checking forever",
  { timeout: 5000 },
  async () => {
    const disk = cache();
    const key = cacheKey("migration", "canvas", "legacy");
    const legacy = canvas("legacy", 329);
    const migrated: CanvasDocument = {
      ...canvas("legacy", 0),
      syncMode: "collaborative",
      roomEpoch: "migrated-room",
    };

    await disk.cache.put(key, legacy);
    let reads = 0;
    const manager = new CanvasResources(
      "migration",
      {
        readCanvas: async () => {
          assert.equal(
            ++reads,
            1,
            "migration must not retry a lower room sequence",
          );

          return migrated;
        },
        readLibrary: library,
      },
      () => {},
      disk.cache,
    );

    try {
      const entry = await manager.open("legacy", () => {});

      assert.equal(entry.status, "ready");
      assert.deepEqual(entry.document, migrated);
      assert.equal(entry.resource.revision, 0);
      assert.deepEqual(await disk.cache.get(key), migrated);
      assert.deepEqual(disk.entries.get(key)?.value, migrated);
    } finally {
      manager.dispose();
    }
  },
);

test("cache memory and IndexedDB replace a previous epoch with a lower confirmed revision", async () => {
  const key = cacheKey("restore-domain", "canvas", "restored");
  const cache = new ConfirmedCache();
  const old = {
    ...canvas("restored", 100),
    syncMode: "collaborative" as const,
    roomEpoch: "before",
  };
  const restored = {
    ...canvas("restored", 0),
    syncMode: "collaborative" as const,
    roomEpoch: "after",
  };

  try {
    await cache.put(key, old, "collaboration:before");
    await cache.put(key, restored, "collaboration:after");
    assert.deepEqual(cache.peek(key), restored);
    cache.clearMemory();
    assert.deepEqual(await cache.get(key), restored);
    await cache.put(key, { ...restored, revision: 2 }, "collaboration:after");
    await cache.put(key, restored, "collaboration:after");
    assert.equal(cache.peek<CanvasDocument>(key)?.revision, 2);
    cache.clearMemory();
    assert.equal((await cache.get<CanvasDocument>(key))?.revision, 2);
  } finally {
    await cache.remove(key);
  }
});

test("migration preserves an older draft without a saved baseline even when its revision equals the room sequence", async () => {
  let migrated = false;
  const manager = new CanvasResources(
    "migration-draft",
    {
      readCanvas: async () => ({
        ...canvas("dirty", 0),
        ...(migrated
          ? { syncMode: "collaborative" as const, roomEpoch: "new-room" }
          : {}),
      }),
      readLibrary: library,
    },
    () => {},
    cache().cache,
  );

  try {
    const entry = await manager.open("dirty", () => {});

    entry.resource.update(scene("unsaved-local"));
    entry.resource.baseline = undefined; // Old browser drafts predate baseline storage.
    migrated = true;
    await manager.open("dirty", () => {});
    await manager.open("dirty", () => {});
    assert.equal(entry.status, "conflict");
    assert.equal(entry.resource.dirty, true);
    assert.deepEqual(entry.resource.value, scene("unsaved-local"));
    await assert.rejects(entry.resource.flush(), /冲突/);
  } finally {
    manager.dispose();
  }
});

test("switching canvases sends zero library reads; first explicit library request deduplicates and reuses the resource", async () => {
  let reads = 0;
  const gate = deferred<{ items: unknown[]; revision: number }>();
  const manager = new CanvasResources(
    "lazy",
    {
      readCanvas: async (id) => canvas(id),
      readLibrary: async () => {
        reads++;

        return gate.promise;
      },
    },
    () => {},
    cache().cache,
  );

  try {
    await manager.open("a", () => {});
    await manager.open("b", () => {});
    assert.equal(reads, 0);
    assert.equal(manager.libraryStatus, "unloaded");
    assert.equal(manager.library, undefined);
    const first = manager.ensureLibrary();
    const duplicate = manager.ensureLibrary();

    gate.resolve({ items: [], revision: 3 });
    await Promise.all([first, duplicate]);
    assert.equal(reads, 1);
    assert.equal(manager.libraryStatus, "ready");
    assert.equal(
      manager.library?.dirty,
      false,
      "a genuinely empty loaded library is not a pending write",
    );
    await manager.open("a", () => {});
    await manager.ensureLibrary();
    assert.equal(reads, 1);
  } finally {
    manager.dispose();
  }
});

test("cached scene is previewed read-only before unchanged validation resolves, without fetching its body twice", async () => {
  const disk = cache();
  const original = canvas("unchanged", 4);

  await disk.cache.put(cacheKey("cached", "canvas", original.id), original);
  const gate = deferred<CanvasDocument | undefined>();
  const statuses: string[] = [];
  const previewed = deferred<void>();
  const manager = new CanvasResources(
    "cached",
    {
      readCanvas: async () => {
        throw Error("unexpected full read");
      },
      readLibrary: library,
      validateCanvas: async (_id, owner, known) => {
        assert.equal(owner, "cached");
        assert.equal(known?.revision, 4);

        return gate.promise;
      },
    },
    () => {},
    disk.cache,
  );

  try {
    const loading = manager.open(original.id, (entry) => {
      statuses.push(entry.status);
      previewed.resolve();
    });

    await previewed.promise;
    assert.deepEqual(statuses, ["checking"]);
    gate.resolve(undefined);
    const entry = await loading;

    assert.equal(entry.status, "ready");
    assert.equal(entry.resource.dirty, false);
    assert.equal(entry.version, 0);
  } finally {
    manager.dispose();
  }
});

test("new cloud version replaces only a clean cached scene and increments editor mount version", async () => {
  const disk = cache();

  await disk.cache.put(cacheKey("newer", "canvas", "a"), canvas("a", 1));
  const manager = new CanvasResources(
    "newer",
    { readCanvas: async () => canvas("a", 2, "new"), readLibrary: library },
    () => {},
    disk.cache,
  );

  try {
    const entry = await manager.open("a", () => {});

    assert.equal(entry.status, "ready");
    assert.equal(entry.version, 1);
    assert.deepEqual(entry.resource.value, scene("new"));
    assert.equal(entry.resource.revision, 2);
  } finally {
    manager.dispose();
  }
});

test("network failure retains a locked cached scene; access failure invalidates and stops showing it", async () => {
  const disk = cache();

  await disk.cache.put(cacheKey("failure", "canvas", "a"), canvas("a"));
  let failure: Error = Error("offline");
  const manager = new CanvasResources(
    "failure",
    {
      readCanvas: async () => {
        throw failure;
      },
      readLibrary: library,
    },
    () => {},
    disk.cache,
  );

  try {
    const entry = await manager.open("a", () => {});

    assert.equal(entry.status, "error");
    assert.match(entry.message, /offline/);
    failure = new ApiError(404, "NOT_FOUND", "deleted");
    await assert.rejects(
      manager.open("a", () => {}),
      /deleted/,
    );
    assert.equal(manager.canvases.has("a"), false);
    assert.equal(
      await disk.cache.get(cacheKey("failure", "canvas", "a")),
      undefined,
    );
  } finally {
    manager.dispose();
  }
});

test("a dirty draft with a changed base remains intact and requires explicit conflict resolution", async () => {
  let revision = 1;
  const manager = new CanvasResources(
    "conflict",
    { readCanvas: async (id) => canvas(id, revision), readLibrary: library },
    () => {},
    cache().cache,
  );

  try {
    const entry = await manager.open("a", () => {});

    entry.resource.update(scene("local-only"));
    revision = 2;
    await manager.open("a", () => {});
    assert.equal(entry.status, "conflict");
    assert.equal(entry.resource.revision, 1);
    assert.deepEqual(entry.resource.value, scene("local-only"));
    await assert.rejects(entry.resource.flush(), /冲突/);
    await entry.resource.checkpoint();
  } finally {
    manager.dispose();
  }
});

test("A saves in background while B becomes editable; fast return waits for A own write before validation", async () => {
  const original = globalThis.fetch;
  const gate = deferred<Response>();
  let revisionA = 0;
  const manager = new CanvasResources(
    "background",
    {
      readCanvas: async (id) => canvas(id, id === "a" ? revisionA : 0),
      readLibrary: library,
    },
    () => {},
    cache().cache,
  );

  globalThis.fetch = (async () => gate.promise) as typeof fetch;
  try {
    const a = await manager.open("a", () => {});

    a.resource.update(scene("edited-a"));
    await a.resource.checkpoint();
    const saving = a.resource.flush();
    const b = await manager.open("b", () => {});

    assert.equal(b.status, "ready");
    assert.equal(a.resource.isSaving, true);
    const returning = manager.open("a", () => {});

    assert.equal(a.status, "checking");
    revisionA = 1;
    gate.resolve(Response.json({ revision: 1, updatedAt: "version-1" }));
    await saving;
    await returning;
    assert.equal(a.status, "ready");
    assert.equal(a.resource.conflict, false);
  } finally {
    manager.dispose();
    globalThis.fetch = original;
  }
});

test("save acknowledgment caches exactly the sent snapshot; newer edits remain dirty and save in order", async () => {
  const original = globalThis.fetch;
  const first = deferred<Response>();
  const second = deferred<Response>();
  const sent: any[] = [];
  const confirmed: any[] = [];
  const resource = new PersistentResource({
    key: "ack:canvas:a",
    path: "/api/canvases/a",
    field: "scene",
    value: scene("zero"),
    revision: 0,
    scopeId: "ack-test",
    ownerId: "ack",
    changed: () => {},
    confirmed: (value, result) => confirmed.push({ value, result }),
  });

  globalThis.fetch = (async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)));

    return sent.length === 1 ? first.promise : second.promise;
  }) as typeof fetch;
  try {
    resource.update(scene("first"));
    const saving = resource.flush();

    resource.update(scene("second"));
    first.resolve(Response.json({ revision: 1, updatedAt: "one" }));
    while (sent.length < 2)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(confirmed[0].value, scene("first"));
    assert.equal(resource.dirty, true);
    assert.equal(sent[1].revision, 1);
    second.resolve(Response.json({ revision: 2, updatedAt: "two" }));
    await saving;
    assert.equal(resource.dirty, false);
    assert.deepEqual(confirmed[1].value, scene("second"));
  } finally {
    resource.dispose();
    globalThis.fetch = original;
  }
});

test("lost save response is verified by readback before retry, acknowledging its own accepted snapshot", async () => {
  const original = globalThis.fetch;
  let puts = 0;
  let reads = 0;
  const resource = new PersistentResource({
    key: "lost:canvas:a",
    path: "/api/canvases/a",
    field: "scene",
    value: scene("zero"),
    revision: 0,
    scopeId: "lost-test",
    ownerId: "lost",
    changed: () => {},
    readRemote: async () => {
      reads++;

      return { value: scene("accepted"), revision: 1 };
    },
  });

  globalThis.fetch = (async () => {
    puts++;
    throw Error("response lost after commit");
  }) as typeof fetch;
  try {
    resource.update(scene("accepted"));
    await assert.rejects(resource.flush(), /response lost/);
    await resource.flush();
    assert.equal(puts, 1);
    assert.equal(reads, 1);
    assert.equal(resource.revision, 1);
    assert.equal(resource.dirty, false);
  } finally {
    resource.dispose();
    globalThis.fetch = original;
  }
});

test("confirmed cache is immutable, rejects old revisions, and scopes account keys separately", async () => {
  const disk = cache();
  const value = canvas("a", 3);

  await disk.cache.put(cacheKey("alice", "canvas", "a"), value);
  value.scene.elements.push({ id: "mutated" });
  const loaded = (await disk.cache.get<CanvasDocument>(
    cacheKey("alice", "canvas", "a"),
  ))!;

  loaded.scene.elements.length = 0;
  await disk.cache.put(cacheKey("alice", "canvas", "a"), canvas("a", 1));
  assert.equal(
    (await disk.cache.get<CanvasDocument>(cacheKey("alice", "canvas", "a")))
      ?.revision,
    3,
  );
  assert.equal(
    (await disk.cache.get<CanvasDocument>(cacheKey("alice", "canvas", "a")))
      ?.scene.elements.length,
    1,
  );
  assert.equal(await disk.cache.get(cacheKey("bob", "canvas", "a")), undefined);
});

test("clean memory LRU evicts old resources while preserving dirty resources and their drafts", async () => {
  const originalNow = Date.now;
  let now = originalNow();

  Date.now = () => ++now;
  const manager = new CanvasResources(
    "lru",
    { readCanvas: async (id) => canvas(id), readLibrary: library },
    () => {},
    cache().cache,
  );

  try {
    const dirty = await manager.open("dirty", () => {});

    dirty.resource.update(scene("keep-me"));
    dirty.resource.conflict = true;
    await dirty.resource.checkpoint();
    for (let index = 0; index < 9; index++) {
      const id = `clean-${index}`;

      await manager.open(id, () => {});
      manager.setActive(id);
    }

    assert.equal(manager.canvases.has("clean-0"), false);
    assert.equal(manager.canvases.get("dirty"), dirty);
    assert.equal(manager.canvases.size, 6);
    const recovered = new PersistentResource({
      key: "lru:canvas:dirty",
      path: "/api/canvases/dirty",
      field: "scene",
      value: scene("cloud"),
      revision: 0,
      changed: () => {},
    });

    await recovered.restore();
    assert.deepEqual(recovered.value, scene("keep-me"));
    recovered.dispose();
  } finally {
    manager.dispose();
    Date.now = originalNow;
  }
});

test("latest selection wins A/B/C out of order, including shared in-flight B request", async () => {
  const gates = new Map(
    ["a", "b", "c"].map((id) => [id, deferred<CanvasDocument>()]),
  );
  const reads: string[] = [];
  const controller = useCanvasDocument({
    api: {
      readCanvas: async (id) => {
        reads.push(id);

        return gates.get(id)!.promise;
      },
      readLibrary: library,
    },
    ownerId: () => "latest",
    onLoaded: () => {},
  });

  try {
    const a = controller.loadCanvas("a");
    const b = controller.loadCanvas("b");
    const c = controller.loadCanvas("c");

    gates.get("c")!.resolve(canvas("c"));
    await c;
    gates.get("b")!.resolve(canvas("b"));
    await b;
    gates.get("a")!.resolve(canvas("a"));
    await a;
    assert.equal(controller.document.value?.id, "c");
    assert.deepEqual(reads, ["a", "b", "c"]);
  } finally {
    controller.reset();
  }
});

test("account reset discards delayed reads without publishing the previous account scene", async () => {
  let owner = "old-owner";
  const gate = deferred<CanvasDocument>();
  const controller = useCanvasDocument({
    api: {
      readCanvas: async (id) => (id === "old" ? gate.promise : canvas(id)),
      readLibrary: library,
    },
    ownerId: () => owner,
    onLoaded: () => {},
  });
  const old = controller.loadCanvas("old");

  controller.reset();
  owner = "new-owner";
  await controller.loadCanvas("new");
  gate.resolve(canvas("old"));
  await old;
  assert.equal(controller.document.value?.id, "new");
  assert.equal(controller.resources.value?.owner, "new-owner");
  controller.reset();
});

test("all-dirty flush barrier includes a non-selected canvas and rejects its conflict", async () => {
  const manager = new CanvasResources(
    "all-dirty",
    { readCanvas: async (id) => canvas(id), readLibrary: library },
    () => {},
    cache().cache,
  );

  try {
    const a = await manager.open("a", () => {});

    a.resource.update(scene("unsaved"));
    a.resource.conflict = true;
    await manager.open("b", () => {});
    manager.setActive("b");
    await assert.rejects(manager.flushAll(), /冲突/);
    assert.equal(manager.hasDirty(), true);
  } finally {
    manager.dispose();
  }
});

test("recent-position writer serializes and coalesces selections so late A cannot overwrite C", async () => {
  const gate = deferred<void>();
  const writes: string[] = [];
  let revision = 0;
  const nav = () => ({
    revision,
    lastWorkspaceId: "space",
    lastCanvasId: writes.at(-1) ?? null,
    workspaces: [],
  });
  const navigation = useWorkspaceNavigation({
    readNavigation: async () => nav(),
    recordOpened: async (id, expected) => {
      assert.equal(expected, revision);
      writes.push(id);
      if (id === "a") await gate.promise;
      revision++;

      return nav();
    },
  });
  const first = navigation.recordOpened("a");

  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = navigation.recordOpened("b");
  const third = navigation.recordOpened("c");

  gate.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(writes, ["a", "c"]);
  assert.equal(navigation.navigation.value?.lastCanvasId, "c");
});

test("conditional API accepts a bodyless 304 without JSON parsing", async () => {
  const original = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(null, { status: 304 })) as typeof fetch;
  try {
    assert.equal(await conditionalApi("/api/canvases/a"), undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("a draft without a clean cache previews first and never enters the confirmed cache as a clean snapshot", async () => {
  const draft = new PersistentResource({
    key: "draft-only:canvas:a",
    path: "/api/canvases/a",
    field: "scene",
    value: scene("cloud"),
    revision: 0,
    changed: () => {},
  });

  draft.update(scene("unsynchronized"));
  await draft.checkpoint();
  draft.dispose();
  const disk = cache();
  const gate = deferred<CanvasDocument>();
  const shown = deferred<void>();
  const manager = new CanvasResources(
    "draft-only",
    { readCanvas: async () => gate.promise, readLibrary: library },
    () => {},
    disk.cache,
  );
  const loading = manager.open("a", (entry) => {
    if (entry.status === "checking") {
      assert.deepEqual(entry.resource.value, scene("unsynchronized"));
      shown.resolve();
    }
  });

  try {
    await shown.promise;
    assert.equal(disk.entries.size, 0);
    gate.resolve(canvas("a"));
    const entry = await loading;

    assert.equal(entry.resource.dirty, true);
    assert.equal(entry.status, "ready");
    assert.deepEqual(
      (
        disk.entries.get(cacheKey("draft-only", "canvas", "a"))!
          .value as CanvasDocument
      ).scene,
      scene("a"),
    );
  } finally {
    manager.dispose();
  }
});

test("returning after a lost own save response reconciles before version validation instead of inventing a conflict", async () => {
  const original = globalThis.fetch;
  let accepted = false;
  const manager = new CanvasResources(
    "own-lost",
    {
      readCanvas: async (id) =>
        canvas(id, accepted ? 1 : 0, accepted ? "accepted" : id),
      readLibrary: library,
    },
    () => {},
    cache().cache,
  );

  globalThis.fetch = (async () => {
    accepted = true;
    throw Error("response lost");
  }) as typeof fetch;
  try {
    const a = await manager.open("a", () => {});

    a.resource.update(scene("accepted"));
    await assert.rejects(a.resource.flush(), /response lost/);
    await manager.open("b", () => {});
    await manager.open("a", () => {});
    assert.equal(a.resource.revision, 1);
    assert.equal(a.status, "ready");
    assert.equal(a.resource.conflict, false);
    assert.equal(a.resource.dirty, false);
  } finally {
    manager.dispose();
    globalThis.fetch = original;
  }
});

test("same canvas in-flight reads are shared between selections", async () => {
  const gate = deferred<CanvasDocument>();
  let reads = 0;
  const manager = new CanvasResources(
    "dedup",
    {
      readCanvas: async () => {
        reads++;

        return gate.promise;
      },
      readLibrary: library,
    },
    () => {},
    cache().cache,
  );

  try {
    const first = manager.open("a", () => {});
    const second = manager.open("a", () => {});

    gate.resolve(canvas("a"));
    assert.equal(await first, await second);
    assert.equal(reads, 1);
  } finally {
    manager.dispose();
  }
});

test(
  "background writes are bounded to two resources while each retains its own revision",
  { timeout: 5000 },
  async () => {
    const original = globalThis.fetch;
    const gates: ReturnType<typeof deferred<Response>>[] = [];
    let active = 0;
    let maximum = 0;
    const manager = new CanvasResources(
      "bounded",
      { readCanvas: async (id) => canvas(id), readLibrary: library },
      () => {},
      cache().cache,
    );

    globalThis.fetch = (async () => {
      const gate = deferred<Response>();

      gates.push(gate);
      active++;
      maximum = Math.max(maximum, active);
      try {
        return await gate.promise;
      } finally {
        active--;
      }
    }) as typeof fetch;
    try {
      for (const id of ["a", "b", "c", "d"]) {
        const entry = await manager.open(id, () => {});

        entry.resource.update(scene(`edited-${id}`));
      }

      const saving = manager.flushAll();

      while (gates.length < 2)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(gates.length, 2);
      for (let index = 0; index < 4; index++) {
        while (!gates[index])
          await new Promise<void>((resolve) => setImmediate(resolve));
        gates[index]!.resolve(
          Response.json({ revision: 1, updatedAt: "version-1" }),
        );
      }

      await saving;
      assert.equal(maximum, 2);
      assert.equal(manager.hasDirty(), false);
    } finally {
      manager.dispose();
      globalThis.fetch = original;
    }
  },
);

test("disk clean-cache LRU removes only confirmed records and leaves independent drafts intact", async () => {
  const storage = new ConfirmedCache(undefined, 0, 0, 650);
  const draft = new PersistentResource({
    key: "disk-lru:canvas:dirty",
    path: "/api/canvases/dirty",
    field: "scene",
    value: scene("cloud"),
    revision: 0,
    changed: () => {},
  });

  try {
    draft.update(scene("durable-draft"));
    draft.conflict = true;
    await draft.checkpoint();
    for (const id of ["first", "second", "third"])
      await storage.put(cacheKey("disk-lru", "canvas", id), {
        revision: 0,
        payload: id.repeat(80),
      });
    assert.equal(
      await storage.get(cacheKey("disk-lru", "canvas", "first")),
      undefined,
    );
    assert.ok(await storage.get(cacheKey("disk-lru", "canvas", "third")));
    const restored = new PersistentResource({
      key: "disk-lru:canvas:dirty",
      path: "/api/canvases/dirty",
      field: "scene",
      value: scene("cloud"),
      revision: 0,
      changed: () => {},
    });

    await restored.restore();
    assert.deepEqual(restored.value, scene("durable-draft"));
    restored.dispose();
  } finally {
    draft.dispose();
  }
});

test("lazy library displays a disposable cached preview while still refusing edits until validation", async () => {
  const disk = cache();
  const gate = deferred<{ items: unknown[]; revision: number }>();
  const shown = deferred<void>();

  await disk.cache.put(
    cacheKey("library-preview", "library", "library-preview"),
    { revision: 2, items: [{ id: "cached-library" }] },
  );
  let manager: CanvasResources;

  manager = new CanvasResources(
    "library-preview",
    {
      readCanvas: async (id) => canvas(id),
      readLibrary: async () => gate.promise,
    },
    () => {
      if (manager.libraryPreview) shown.resolve();
    },
    disk.cache,
  );
  try {
    const loading = manager.ensureLibrary();

    await shown.promise;
    assert.deepEqual(manager.libraryPreview, [{ id: "cached-library" }]);
    assert.equal(manager.libraryStatus, "loading");
    assert.equal(manager.library, undefined);
    gate.resolve({ items: [], revision: 3 });
    await loading;
    assert.equal(manager.libraryPreview, undefined);
    assert.equal(manager.library?.dirty, false);
  } finally {
    manager.dispose();
  }
});

test("navigation reset lets the new account record immediately without stale queue acknowledgments", async () => {
  const gate = deferred<void>();
  let owner = "old";
  const writes: string[] = [];
  const navigation = useWorkspaceNavigation(
    {
      readNavigation: async () => ({
        revision: 0,
        lastWorkspaceId: "space",
        lastCanvasId: null,
        workspaces: [],
      }),
      recordOpened: async (id, _revision, capturedOwner) => {
        writes.push(`${capturedOwner}:${id}`);
        if (capturedOwner === "old") await gate.promise;

        return {
          revision: 1,
          lastWorkspaceId: "space",
          lastCanvasId: id,
          workspaces: [],
        };
      },
    },
    () => owner,
  );
  const old = navigation.recordOpened("a");

  await new Promise<void>((resolve) => setImmediate(resolve));
  navigation.reset();
  owner = "new";
  await navigation.recordOpened("b");
  gate.resolve();
  await old;
  assert.deepEqual(writes, ["old:a", "new:b"]);
  assert.equal(navigation.navigation.value?.lastCanvasId, "b");
});

test(
  "return waits for all generations of its own in-flight save before validating",
  { timeout: 5000 },
  async () => {
    const original = globalThis.fetch;
    const first = deferred<Response>();
    const second = deferred<Response>();
    let revision = 0;
    let writes = 0;
    let reads = 0;
    const manager = new CanvasResources(
      "save-chain",
      {
        readCanvas: async (id) => {
          reads++;

          return canvas(id, revision);
        },
        readLibrary: library,
      },
      () => {},
      cache().cache,
    );

    globalThis.fetch = (async () =>
      ++writes === 1 ? first.promise : second.promise) as typeof fetch;
    try {
      const entry = await manager.open("a", () => {});

      entry.resource.update(scene("first"));
      const saving = entry.resource.flush();

      entry.resource.update(scene("second"));
      const returning = manager.open("a", () => {});

      revision = 1;
      first.resolve(Response.json({ revision, updatedAt: "version-1" }));
      while (writes < 2)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(reads, 1);
      assert.equal(entry.status, "checking");
      revision = 2;
      second.resolve(Response.json({ revision, updatedAt: "version-2" }));
      await Promise.all([saving, returning]);
      assert.equal(entry.resource.conflict, false);
      assert.equal(entry.status, "ready");
      assert.equal(entry.resource.revision, 2);
    } finally {
      manager.dispose();
      globalThis.fetch = original;
    }
  },
);

test(
  "queued autosave stays paused during version validation and resumes after unlock",
  { timeout: 5000 },
  async () => {
    const original = globalThis.fetch;
    const checking = deferred<CanvasDocument>();
    let reads = 0;
    let writes = 0;
    const manager = new CanvasResources(
      "save-paused",
      {
        readCanvas: async (id) =>
          ++reads === 1 ? canvas(id) : checking.promise,
        readLibrary: library,
      },
      () => {},
      cache().cache,
    );

    globalThis.fetch = (async () => {
      writes++;

      return Response.json({ revision: 1, updatedAt: "version-1" });
    }) as typeof fetch;
    try {
      const entry = await manager.open("a", () => {});

      entry.resource.update(scene("pending"));
      entry.resource.schedule(0);
      const returning = manager.open("a", () => {});

      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      assert.equal(writes, 0);
      assert.equal(entry.status, "checking");
      checking.resolve(canvas("a"));
      await returning;
      assert.equal(entry.status, "ready");
      assert.equal(entry.resource.dirty, true);
      entry.resource.schedule(0);
      while (!writes)
        await new Promise<void>((resolve) => setImmediate(resolve));
      await entry.resource.settle();
      assert.equal(entry.resource.dirty, false);
    } finally {
      manager.dispose();
      globalThis.fetch = original;
    }
  },
);

test(
  "a delayed validation cannot roll back an explicit save accepted during its GET",
  { timeout: 5000 },
  async () => {
    const original = globalThis.fetch;
    const gate = deferred<CanvasDocument>();
    let reads = 0;
    let revision = 0;
    const manager = new CanvasResources(
      "late-validation",
      {
        readCanvas: async (id) => {
          reads++;

          return reads === 2
            ? gate.promise
            : canvas(id, revision, revision ? "edited" : "original");
        },
        readLibrary: library,
      },
      () => {},
      cache().cache,
    );

    globalThis.fetch = (async () => {
      revision = 1;

      return Response.json({ revision, updatedAt: "version-1" });
    }) as typeof fetch;
    try {
      const entry = await manager.open("a", () => {});

      entry.resource.update(scene("edited"));
      const returning = manager.open("a", () => {});

      await entry.resource.flush();
      gate.resolve(canvas("a", 0, "original"));
      await returning;
      assert.equal(reads, 3);
      assert.equal(entry.status, "ready");
      assert.equal(entry.resource.revision, 1);
      assert.equal(entry.resource.value.elements[0]!.id, "edited");
    } finally {
      manager.dispose();
      globalThis.fetch = original;
    }
  },
);

test("a rename acknowledged during validation cannot be replaced by old same-revision metadata", async () => {
  const gate = deferred<CanvasDocument>();
  let reads = 0;
  const controller = useCanvasDocument({
    ownerId: () => "rename-epoch",
    onLoaded: () => {},
    api: {
      readCanvas: async (id) => {
        reads++;
        if (reads === 2) return gate.promise;

        return { ...canvas(id), name: reads > 2 ? "new name" : "old name" };
      },
      readLibrary: library,
    },
  });

  try {
    await controller.loadCanvas("a");
    const checking = controller.loadCanvas("a");

    controller.renameLoadedCanvas("a", "new name");
    gate.resolve({ ...canvas("a"), name: "old name" });
    await checking;
    assert.equal(reads, 3);
    assert.equal(controller.document.value?.name, "new name");
  } finally {
    controller.reset();
  }
});

test(
  "draft quota failure blocks switching until cloud confirmation, preserving the last in-memory copy on failure",
  { timeout: 5000 },
  async () => {
    const originalFetch = globalThis.fetch;
    const originalTransaction = IDBDatabase.prototype.transaction;
    const gate = deferred<Response>();
    const manager = new CanvasResources(
      "draft-quota",
      {
        readCanvas: async (id) => canvas(id),
        readLibrary: library,
      },
      () => {},
      cache().cache,
    );

    try {
      const entry = await manager.open("a", () => {});

      IDBDatabase.prototype.transaction = function (...args: any[]) {
        if (
          this.name === "excalidraw-account-drafts" &&
          args[1] === "readwrite"
        )
          throw new DOMException(
            "Simulated quota failure",
            "QuotaExceededError",
          );

        return originalTransaction.apply(this, args as never);
      } as typeof originalTransaction;
      globalThis.fetch = (async () => gate.promise) as typeof fetch;
      entry.resource.update(scene("last-copy"));
      let completed = false;
      const protecting = manager.checkpoint("a").then(() => {
        completed = true;
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(completed, false);
      gate.reject(new TypeError("Simulated offline"));
      await assert.rejects(protecting, /Simulated offline/);
      assert.equal(entry.resource.dirty, true);
      assert.equal(entry.resource.value.elements[0]!.id, "last-copy");
      // After storage recovers, retry verifies the uncertain result then safely saves the same draft.
      IDBDatabase.prototype.transaction = originalTransaction;
      globalThis.fetch = (async () =>
        Response.json({ revision: 1, updatedAt: "version-1" })) as typeof fetch;
      await manager.checkpoint("a");
      await entry.resource.flush();
      assert.equal(entry.resource.dirty, false);
    } finally {
      IDBDatabase.prototype.transaction = originalTransaction;
      manager.dispose();
      globalThis.fetch = originalFetch;
    }
  },
);

test("invalidating a cold loading canvas prevents its late successful GET from publishing or re-caching it", async () => {
  const gate = deferred<CanvasDocument>();
  const controller = useCanvasDocument({
    ownerId: () => "deleted-loading",
    onLoaded: () => {},
    api: { readCanvas: async () => gate.promise, readLibrary: library },
  });

  try {
    const loading = controller.loadCanvas("deleted");

    assert.equal(controller.invalidateCanvas("deleted"), true);
    gate.resolve(canvas("deleted"));
    await loading;
    assert.equal(controller.document.value, undefined);
    assert.equal(controller.resources.value?.canvases.has("deleted"), false);
    assert.equal(
      await controller.resources.value?.cache.get(
        cacheKey("deleted-loading", "canvas", "deleted"),
      ),
      undefined,
    );
  } finally {
    controller.reset();
  }
});

test("accepting a clean remote version also advances the persisted draft baseline for a later collaborative handoff", async () => {
  let revision = 0;
  const manager = new CanvasResources(
    "updated-baseline",
    {
      readCanvas: async () =>
        canvas("baseline", revision, `remote-${revision}`),
      readLibrary: library,
    },
    () => {},
    cache().cache,
  );

  try {
    const entry = await manager.open("baseline", () => {});

    revision = 1;
    await manager.open("baseline", () => {});
    assert.deepEqual(entry.resource.baseline, scene("remote-1"));
    entry.resource.update(scene("local"));
    await entry.resource.checkpoint();
    const restored = new PersistentResource({
      key: "updated-baseline:canvas:baseline",
      path: "/unused",
      field: "scene",
      value: scene("future-server"),
      revision: 2,
      changed: () => {},
    });

    try {
      await restored.restore();
      assert.deepEqual(restored.baseline, scene("remote-1"));
      assert.deepEqual(restored.value, scene("local"));
    } finally {
      restored.dispose();
    }
  } finally {
    manager.dispose();
  }
});

test("legacy drafts with baselines remain recoverable instead of being replayed into a restored room epoch", async () => {
  let restored = false;
  const manager = new CanvasResources(
    "restored-migration",
    {
      readCanvas: async () => ({
        ...canvas("restored-migration"),
        ...(restored
          ? {
              syncMode: "collaborative" as const,
              roomEpoch: "restored",
              migrationEpoch: "original-migration",
            }
          : {}),
      }),
      readLibrary: library,
    },
    () => {},
    cache().cache,
  );

  try {
    const entry = await manager.open("restored-migration", () => {});

    entry.resource.update(scene("unsaved-local"));
    assert.ok(entry.resource.baseline);
    restored = true;
    await manager.open("restored-migration", () => {});
    assert.equal(entry.status, "conflict");
    assert.equal(entry.resource.dirty, true);
    assert.deepEqual(entry.resource.value, scene("unsaved-local"));
  } finally {
    manager.dispose();
  }
});

test("authoritative restore revives the same id while an old deleted read cannot replace it or unrelated drafts", async () => {
  const oldRead = deferred<CanvasDocument>();
  let reads = 0;
  const manager = new CanvasResources(
    "recycle-revive",
    {
      readCanvas: async (id) =>
        id === "a" && ++reads === 1
          ? oldRead.promise
          : canvas(id, 2, "restored"),
      readLibrary: library,
    },
    () => {},
    cache().cache,
  );

  try {
    const unrelated = await manager.open("b", () => {});

    unrelated.resource.update(scene("unrelated-draft"));
    const previews: string[] = [];
    const loading = manager.open("a", (entry) =>
      previews.push(entry.document.scene.elements[0] as string),
    );
    const rejected = assert.rejects(
      loading,
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError",
    );

    await manager.invalidate("a");
    await assert.rejects(
      manager.open("a", () => {}),
      /画布已删除/,
    );
    await manager.revive("a");
    const restored = await manager.open("a", () => {});

    oldRead.resolve(canvas("a", 0, "stale"));
    await rejected;
    assert.equal(restored.resource.revision, 2);
    assert.equal(manager.canvases.get("a"), restored);
    assert.ok(!previews.length);
    assert.equal(manager.canvases.get("b"), unrelated);
    assert.equal(unrelated.resource.dirty, true);
    assert.deepEqual(unrelated.resource.value, scene("unrelated-draft"));
  } finally {
    oldRead.resolve(canvas("a"));
    manager.dispose();
  }
});
