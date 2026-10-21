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
