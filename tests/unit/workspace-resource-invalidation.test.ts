// 保护删除工作空间时已加载与尚在读取的资源失效，且隔离其他工作空间。
// 真实组件：CanvasResources、ConfirmedCache、PersistentResource；替身：HTTP 读取与缓存磁盘。
// fake-indexeddb 仅隔离草稿存储；不验证浏览器布局、真实服务端删除或云端保存。
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CanvasResources } from "../../src/lib/canvasResources";
import {
  ConfirmedCache,
  cacheKey,
  type CacheEntry,
} from "../../src/lib/confirmedCache";
import type { CanvasDocument } from "../../shared/contracts";

Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: { getItem: () => "workspace-invalidation", setItem: () => {} },
});

const document = (id: string, workspaceId: string): CanvasDocument => ({
  id,
  workspaceId,
  name: id,
  position: 0,
  revision: 0,
  createdAt: "",
  updatedAt: "",
  scene: { elements: [], appState: {}, files: {} },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function isolatedCache() {
  const entries = new Map<string, CacheEntry>();
  const cache = new ConfirmedCache({
    read: async (key) => entries.get(key),
    write: async (entry) => {
      entries.set(entry.key, structuredClone(entry));
    },
    remove: async (key) => {
      entries.delete(key);
    },
  });

  return { cache, entries };
}

test("删除空间使所有已知资源与缓存失效，包括不在目录页中的画布，其他空间仍可读", async () => {
  const disk = isolatedCache();
  const manager = new CanvasResources(
    "workspace-delete-loaded",
    {
      readCanvas: async (id) => document(id, id === "other" ? "two" : "one"),
      readLibrary: async () => ({ items: [], revision: 0 }),
    },
    () => {},
    disk.cache,
  );

  try {
    await manager.open("first-page", () => {}, document("first-page", "one"));
    await manager.open("offpage-65", () => {}, document("offpage-65", "one"));
    const other = await manager.open(
      "other",
      () => {},
      document("other", "two"),
    );

    other.resource.update({
      elements: [{ id: "unsaved-other" }],
      appState: {},
      files: {},
    });
    other.resource.pauseAutosave();
    await manager.invalidateWorkspace("one");
    assert.equal(manager.canvases.has("first-page"), false);
    assert.equal(manager.canvases.has("offpage-65"), false);
    assert.equal(
      await disk.cache.get(cacheKey(manager.owner, "canvas", "first-page")),
      undefined,
    );
    assert.equal(
      await disk.cache.get(cacheKey(manager.owner, "canvas", "offpage-65")),
      undefined,
    );
    assert.equal(manager.canvases.get("other"), other);
    assert.equal(other.resource.dirty, true);
    assert.deepEqual(other.resource.value.elements, [{ id: "unsaved-other" }]);
    await assert.rejects(
      manager.open("offpage-65", () => {}),
      { code: "NOT_FOUND" },
    );
    assert.equal((await manager.open("other", () => {})).document.id, "other");
  } finally {
    manager.dispose();
  }
});

for (const tracking of ["metadata", "workspaceHint"] as const) {
  test(
    `删除空间中止${tracking}归属的未完成读取，迟到响应无效且隔离其他与未知空间`,
    { timeout: 5000 },
    async () => {
      const disk = isolatedCache();
      const deletedResponse = deferred<CanvasDocument>();
      const otherResponse = deferred<CanvasDocument>();
      const unknownResponse = deferred<CanvasDocument>();
      const startedDeleted = deferred<AbortSignal>();
      const startedOther = deferred<AbortSignal>();
      const startedUnknown = deferred<AbortSignal>();
      let deletedPreviews = 0;
      const manager = new CanvasResources(
        `workspace-delete-flight-${tracking}`,
        {
          readCanvas: async () => {
            throw new Error("应使用支持取消的校验端口");
          },
          readLibrary: async () => ({ items: [], revision: 0 }),
          validateCanvas: async (id, _owner, _known, signal) => {
            assert.ok(signal);
            if (id === "pending-one") {
              startedDeleted.resolve(signal);

              return deletedResponse.promise;
            }

            if (id === "pending-unknown") {
              startedUnknown.resolve(signal);

              return unknownResponse.promise;
            }

            startedOther.resolve(signal);

            return otherResponse.promise;
          },
        },
        () => {},
        disk.cache,
      );
      const deletingRead = manager.open(
        "pending-one",
        () => {
          deletedPreviews++;
        },
        tracking === "metadata" ? document("pending-one", "one") : undefined,
        tracking === "workspaceHint" ? "one" : undefined,
      );
      // 立即接管拒绝，避免失效与晚响应之间出现未处理 Promise 拒绝。
      const deletingOutcome = deletingRead.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      const otherRead = manager.open(
        "pending-two",
        () => {},
        document("pending-two", "two"),
      );

      const unknownRead = manager.open("pending-unknown", () => {});

      try {
        const [deletedSignal, otherSignal, unknownSignal] = await Promise.all([
          startedDeleted.promise,
          startedOther.promise,
          startedUnknown.promise,
        ]);

        assert.equal(
          manager.canvases.has("pending-one"),
          false,
          "此读取尚未产生可遍历资源",
        );
        await manager.invalidateWorkspace("one");
        assert.equal(deletedSignal.aborted, true);
        assert.equal(otherSignal.aborted, false);
        assert.equal(unknownSignal.aborted, false);
        deletedResponse.resolve(document("pending-one", "one"));
        otherResponse.resolve(document("pending-two", "two"));
        unknownResponse.resolve(document("pending-unknown", "unknown"));
        const [deleted, other, unknown] = await Promise.all([
          deletingOutcome,
          otherRead,
          unknownRead,
        ]);

        assert.ok(deleted.error instanceof Error);
        assert.equal(deleted.error.name, "AbortError");
        assert.equal(deleted.value, undefined);
        assert.equal(deletedPreviews, 0);
        assert.equal(manager.canvases.has("pending-one"), false);
        assert.equal(
          await disk.cache.get(
            cacheKey(manager.owner, "canvas", "pending-one"),
          ),
          undefined,
        );
        assert.equal(other.document.id, "pending-two");
        assert.equal(manager.canvases.has("pending-two"), true);
        assert.equal(unknown.document.id, "pending-unknown");
      } finally {
        deletedResponse.resolve(document("pending-one", "one"));
        otherResponse.resolve(document("pending-two", "two"));
        unknownResponse.resolve(document("pending-unknown", "unknown"));
        await Promise.allSettled([deletingOutcome, otherRead, unknownRead]);
        manager.dispose();
      }
    },
  );
}

test(
  "已缓存画布等待交接时删除空间，旧打开不能预览失效资源、再次读取或回填缓存",
  { timeout: 5000 },
  async () => {
    const disk = isolatedCache();
    const handoffStarted = deferred<void>();
    const releaseHandoff = deferred<void>();
    let reads = 0;
    let previewsAfterDelete = 0;
    const manager = new CanvasResources(
      "workspace-delete-handoff",
      {
        readCanvas: async (id) => {
          reads++;

          return document(id, "one");
        },
        readLibrary: async () => ({ items: [], revision: 0 }),
      },
      () => {},
      disk.cache,
      async () => {
        handoffStarted.resolve();
        await releaseHandoff.promise;
      },
    );

    try {
      await manager.open("cached", () => {}, document("cached", "one"));
      assert.equal(reads, 1);
      const reopening = manager.open(
        "cached",
        () => {
          previewsAfterDelete++;
        },
        document("cached", "one"),
      );
      const outcome = reopening.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );

      await handoffStarted.promise;
      await manager.invalidateWorkspace("one");
      releaseHandoff.resolve();
      const result = await outcome;

      assert.equal(
        previewsAfterDelete,
        0,
        "交接期间失效的旧资源不能再交给编辑器",
      );
      assert.equal(reads, 1, "删除后的旧打开操作不能重新读取画布");
      assert.ok(result.error instanceof Error);
      assert.ok(
        result.error.name === "AbortError" ||
          ("code" in result.error && result.error.code === "NOT_FOUND"),
      );
      assert.equal(result.value, undefined);
      assert.equal(manager.canvases.has("cached"), false);
      assert.equal(
        await disk.cache.get(cacheKey(manager.owner, "canvas", "cached")),
        undefined,
      );
    } finally {
      releaseHandoff.resolve();
      manager.dispose();
    }
  },
);

test(
  "共享读取完成后预览前删除空间，等待同一读取的第二个打开不能预览或返回失效资源",
  { timeout: 5000 },
  async () => {
    const disk = isolatedCache();
    const response = deferred<CanvasDocument>();
    const readStarted = deferred<void>();
    let reads = 0;
    let joinedPreviews = 0;
    let invalidating: Promise<void> | undefined;
    const manager = new CanvasResources(
      "workspace-delete-joined-flight",
      {
        readCanvas: async () => {
          reads++;
          readStarted.resolve();

          return response.promise;
        },
        readLibrary: async () => ({ items: [], revision: 0 }),
      },
      () => {},
      disk.cache,
    );
    const first = manager.open(
      "joined",
      () => {
        // load 已得成功结果；删除发生在等待同一 flight 的第二个 open 恢复之前。
        queueMicrotask(() => {
          invalidating = manager.invalidateWorkspace("one");
        });
      },
      document("joined", "one"),
    );
    const firstOutcome = first.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );

    try {
      await readStarted.promise;
      const joined = manager.open(
        "joined",
        () => {
          joinedPreviews++;
        },
        document("joined", "one"),
      );
      const joinedOutcome = joined.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );

      response.resolve(document("joined", "one"));
      const result = await joinedOutcome;

      await invalidating;
      assert.equal(reads, 1);
      assert.equal(
        joinedPreviews,
        0,
        "join flight 也必须在交给编辑器前重检失效状态",
      );
      assert.ok(result.error instanceof Error);
      assert.ok(
        result.error.name === "AbortError" ||
          ("code" in result.error && result.error.code === "NOT_FOUND"),
      );
      assert.equal(result.value, undefined);
      assert.equal(manager.canvases.has("joined"), false);
      assert.equal(
        await disk.cache.get(cacheKey(manager.owner, "canvas", "joined")),
        undefined,
      );
    } finally {
      response.resolve(document("joined", "one"));
      await firstOutcome;
      await invalidating;
      manager.dispose();
    }
  },
);
