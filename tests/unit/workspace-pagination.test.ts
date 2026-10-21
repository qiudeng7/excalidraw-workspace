// 保护分页目录的请求隔离、版本恢复、局部变更与标签/资源存续约束。
// 真实组件：useWorkspaceDirectory 与 useCanvasTabs；替身：有状态 HTTP 端口、文档资源与保存屏障。
// 本组只验证客户端编排，不证明数据库持久化、真实后台保存、滚动位置或浏览器交互。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";
import {
  useWorkspaceDirectory,
  type WorkspaceDirectoryDependencies,
} from "../../src/composables/useWorkspaceDirectory";
import { ApiError } from "../../src/lib/api";
import type { WorkspaceApi } from "../../src/lib/workspaceApi";
import type {
  CanvasCatalogPage,
  CanvasCatalogPageRequest,
  CanvasDocument,
  CanvasMeta,
  CanvasMove,
  Navigation,
  Workspace,
} from "../../shared/contracts";

type PageRequest = { workspaceId: string; options: CanvasCatalogPageRequest };

type DirectoryApi = WorkspaceDirectoryDependencies["api"] &
  Pick<
    WorkspaceApi,
    "readCatalogPage" | "readCanvas" | "moveCanvas" | "setCanvasPinnedSummary"
  >;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

const canvas = (index: number, workspaceId = "one"): CanvasDocument => ({
  id: `${workspaceId}-${index}`,
  workspaceId,
  name: `画布 ${index}`,
  pinned: false,
  position: index,
  revision: 0,
  createdAt: "created",
  updatedAt: "updated",
  scene: { elements: [{ id: `element-${index}` }], appState: {}, files: {} },
});
const ids = (entries: readonly CanvasMeta[]) =>
  entries.map((entry) => entry.id);

function fixture(count = 65, recentId?: string) {
  let catalogs: Record<string, CanvasDocument[]> = {
    one: Array.from({ length: count }, (_, index) => canvas(index + 1)),
    two: [canvas(1, "two"), canvas(2, "two")],
  };
  const revisions: Record<string, number> = { one: 1, two: 1 };
  const workspaces: Workspace[] = ["one", "two"].map((id) => ({
    id,
    name: id,
    catalogRevision: 1,
    createdAt: "",
    updatedAt: "",
  }));
  const pageRequests: PageRequest[] = [];
  const readCanvasIds: string[] = [];
  const invalidated: string[] = [];
  const historyReleased: string[] = [];
  const moveWrites: { id: string; move: CanvasMove }[] = [];
  const pinWrites: { id: string; pinned: boolean; catalogRevision: number }[] =
    [];
  const drafts = new Map<string, string>();
  const errors: unknown[] = [];
  const document = ref<CanvasDocument>();
  const navigation = ref<Navigation | null>(
    recentId
      ? {
          revision: 1,
          lastWorkspaceId: "one",
          lastCanvasId: recentId,
          workspaces: [{ workspaceId: "one", lastCanvasId: recentId }],
        }
      : null,
  );
  let legacyReads = 0;
  let legacyReorders = 0;
  let legacyPins = 0;
  let pageFailure = false;
  let pageHook:
    ((request: PageRequest) => Promise<CanvasCatalogPage>) | undefined;
  const find = (id: string) =>
    Object.values(catalogs)
      .flat()
      .find((item) => item.id === id);
  const ordered = (workspaceId: string) =>
    [...catalogs[workspaceId]!].sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) ||
        a.position - b.position ||
        a.id.localeCompare(b.id),
    );
  const snapshot = (
    workspaceId: string,
    options: CanvasCatalogPageRequest = {},
  ): CanvasCatalogPage => {
    const revision = revisions[workspaceId]!;
    const [cursorRevision, cursorOffset] =
      options.cursor?.split(":").map(Number) ?? [];

    if (options.cursor && cursorRevision !== revision)
      throw new ApiError(409, "CATALOG_CONFLICT", "目录版本已更新");
    const offset = cursorOffset ?? 0;
    const entries = ordered(workspaceId);
    const page = entries.slice(offset, offset + (options.limit ?? 30));

    return {
      canvases: page.map(({ scene: _scene, ...meta }) => ({ ...meta })),
      catalogRevision: revision,
      total: entries.length,
      nextCursor:
        offset + page.length < entries.length
          ? `${revision}:${offset + page.length}`
          : null,
    };
  };
  const api: DirectoryApi = {
    listWorkspaces: async () => workspaces,
    readCatalog: async (workspaceId) => {
      legacyReads++;

      return {
        canvases: ordered(workspaceId),
        catalogRevision: revisions[workspaceId]!,
      };
    },
    readCatalogPage: async (workspaceId, options = {}) => {
      const request = { workspaceId, options };

      pageRequests.push(request);
      if (pageFailure) throw new Error("分页网络暂时中断");

      return pageHook ? pageHook(request) : snapshot(workspaceId, options);
    },
    readCanvas: async (id) => {
      readCanvasIds.push(id);
      const found = find(id);

      if (!found) throw new ApiError(404, "NOT_FOUND", "画布不可访问");

      return structuredClone(found);
    },
    reorder: async (workspaceId) => {
      legacyReorders++;

      return {
        canvases: ordered(workspaceId),
        catalogRevision: revisions[workspaceId]!,
      };
    },
    setCanvasPinned: async (id) => {
      legacyPins++;
      const item = find(id)!;

      return {
        canvases: ordered(item.workspaceId),
        catalogRevision: revisions[item.workspaceId]!,
      };
    },
    setCanvasPinnedSummary: async (id, pinned, catalogRevision) => {
      pinWrites.push({ id, pinned, catalogRevision });
      const item = find(id)!;

      item.pinned = pinned;
      revisions[item.workspaceId]!++;

      return {
        canvas: { ...item },
        catalogRevision: revisions[item.workspaceId]!,
      };
    },
    moveCanvas: async (id, move) => {
      moveWrites.push({ id, move });
      const source = find(id)!;
      const target = find(move.targetId)!;

      if (
        source.workspaceId !== target.workspaceId ||
        !!source.pinned !== !!target.pinned
      )
        throw new ApiError(400, "INVALID_MOVE", "不能跨组移动");
      const entries = ordered(source.workspaceId).filter(
        (item) => item.id !== id,
      );
      const targetIndex = entries.findIndex((item) => item.id === target.id);

      entries.splice(
        targetIndex + Number(move.placement === "after"),
        0,
        source,
      );
      entries.forEach((item, index) => {
        item.position = index + 1;
      });
      catalogs[source.workspaceId] = entries;
      revisions[source.workspaceId]!++;

      return { catalogRevision: revisions[source.workspaceId]! };
    },
    createCanvas: async (workspaceId, name) => {
      const created = { ...canvas(1000, workspaceId), id: "created", name };

      catalogs[workspaceId]!.push(created);
      revisions[workspaceId]!++;

      return created;
    },
    renameCanvas: async (id, name) => {
      const item = find(id)!;

      item.name = name;

      return { ...item };
    },
    deleteCanvas: async (id) => {
      const item = find(id)!;

      catalogs[item.workspaceId] = catalogs[item.workspaceId]!.filter(
        (entry) => entry.id !== id,
      );
      revisions[item.workspaceId]!++;
    },
    createWorkspace: async () => workspaces[0]!,
    renameWorkspace: async () => workspaces[0]!,
    deleteWorkspace: async (id) => {
      delete catalogs[id];
      workspaces.splice(
        workspaces.findIndex((entry) => entry.id === id),
        1,
      );
    },
  };
  const controller = useWorkspaceDirectory({
    api,
    navigationController: {
      navigation,
      refreshNavigationQuietly: async () => {},
      recordOpened: async () => {},
    },
    canvasDocument: {
      document,
      loadCanvas: async (id) => {
        document.value = await api.readCanvas(id);
      },
      clearDocument: () => {
        document.value = undefined;
      },
      renameLoadedCanvas: (id, name) => {
        if (document.value?.id === id) document.value.name = name;
      },
      invalidateCanvas: (id) => {
        invalidated.push(id);
        drafts.delete(id);
        const active = document.value?.id === id;

        if (active) document.value = undefined;

        return active;
      },
      releaseEditorHistory: (id) => {
        historyReleased.push(id);
      },
    },
    editor: { flush: async () => {}, checkpoint: async () => {} },
    interactionLocked: ref(false),
    run: async (action) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    },
    dialogs: { prompt: async () => "新画布", confirm: async () => true },
  });

  return {
    controller,
    api,
    document,
    errors,
    pageRequests,
    readCanvasIds,
    invalidated,
    historyReleased,
    drafts,
    moveWrites,
    pinWrites,
    snapshot,
    legacyCalls: () => ({
      reads: legacyReads,
      reorders: legacyReorders,
      pins: legacyPins,
    }),
    hookPages: (hook?: typeof pageHook) => {
      pageHook = hook;
    },
    failPages: (value = true) => {
      pageFailure = value;
    },
    remoteChange: (update: (entries: CanvasDocument[]) => void) => {
      update(catalogs.one!);
      revisions.one!++;
    },
  };
}

test("首次加载只请求30张的一页，标题总数和游标来自服务端", async () => {
  const f = fixture();

  await f.controller.loadWorkspaces();
  assert.equal(f.pageRequests.length, 1);
  assert.equal(f.pageRequests[0]!.options.limit, 30);
  assert.equal(f.pageRequests[0]!.options.cursor, undefined);
  assert.equal(f.controller.canvases.value.length, 30);
  assert.equal(f.controller.total.value, 65);
  assert.equal(f.controller.nextCursor.value, "1:30");
  assert.equal(f.document.value?.id, "one-1");
  assert.deepEqual(f.legacyCalls(), { reads: 0, reorders: 0, pins: 0 });
});

test(
  "同空间并发追加只发一个请求，末页去重且没有游标后停止请求",
  { timeout: 5000 },
  async () => {
    const f = fixture(31);

    await f.controller.loadWorkspaces();
    const gate = deferred<CanvasCatalogPage>();
    const started = deferred<void>();

    f.hookPages(async () => {
      started.resolve();

      return gate.promise;
    });
    const first = f.controller.loadNextPage();
    const second = f.controller.loadNextPage();

    await started.promise;
    assert.equal(f.controller.loadingMore.value, true);
    assert.equal(f.pageRequests.length, 2);
    gate.resolve({
      ...f.snapshot("one", { cursor: "1:30" }),
      // 即使网络适配层重复给出边界项，目录也只能保留一个相同ID。
      canvases: [f.controller.canvases.value[29]!, canvas(31)],
    });
    await Promise.all([first, second]);
    assert.equal(f.controller.canvases.value.length, 31);
    assert.equal(new Set(ids(f.controller.canvases.value)).size, 31);
    assert.equal(f.controller.nextCursor.value, null);
    assert.equal(f.controller.loadingMore.value, false);
    await f.controller.loadNextPage();
    assert.equal(f.pageRequests.length, 2);
  },
);

test("追加失败保留目录和编辑器，等待显式重试后继续原游标", async () => {
  const f = fixture(31);

  await f.controller.loadWorkspaces();
  const before = ids(f.controller.canvases.value);
  const editor = f.document.value;

  f.failPages();
  await f.controller.loadNextPage();
  assert.deepEqual(ids(f.controller.canvases.value), before);
  assert.equal(f.document.value, editor);
  assert.equal(f.controller.nextCursor.value, "1:30");
  assert.ok(f.controller.paginationError.value);
  assert.equal(f.controller.loadingMore.value, false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.pageRequests.length, 2, "失败后不能自行循环重试");
  f.failPages(false);
  await f.controller.loadNextPage();
  assert.equal(f.pageRequests.at(-1)!.options.cursor, "1:30");
  assert.equal(f.controller.canvases.value.length, 31);
  assert.equal(f.controller.paginationError.value, "");
});

test(
  "分页冲突原子刷新已经加载的范围，等待刷新时不混入新版或清空旧列表",
  { timeout: 5000 },
  async () => {
    const f = fixture();

    await f.controller.loadWorkspaces();
    await f.controller.loadNextPage();
    const before = ids(f.controller.canvases.value);
    const originalEditor = f.document.value;

    f.remoteChange((entries) => {
      entries[0]!.name = "远端更新";
      entries.splice(1, 1);
    });
    const refreshing = deferred<void>();
    const release = deferred<void>();

    f.hookPages(async (request) => {
      if (!request.options.cursor) {
        refreshing.resolve();
        await release.promise;
      }

      return f.snapshot(request.workspaceId, request.options);
    });
    const loading = f.controller.loadNextPage();

    await refreshing.promise;
    assert.equal(f.controller.refreshing.value, true);
    assert.deepEqual(ids(f.controller.canvases.value), before);
    assert.equal(f.document.value, originalEditor);
    release.resolve();
    await loading;
    assert.equal(f.controller.refreshing.value, false);
    assert.equal(f.controller.canvases.value.length, 60);
    assert.equal(f.controller.canvases.value[0]!.name, "远端更新");
    assert.equal(
      f.controller.canvases.value.some((item) => item.id === "one-2"),
      false,
    );
    assert.equal(f.controller.nextCursor.value, "2:60");
    assert.equal(new Set(ids(f.controller.canvases.value)).size, 60);
  },
);

for (const change of ["新增", "删除", "置顶", "排序"] as const) {
  test(`追加期间远端${change}导致409时恢复新目录并继续使用新版本游标`, async () => {
    const f = fixture();

    await f.controller.loadWorkspaces();
    f.remoteChange((entries) => {
      if (change === "新增") entries.push({ ...canvas(66), position: 0 });
      if (change === "删除") entries.splice(3, 1);
      if (change === "置顶") entries[39]!.pinned = true;
      if (change === "排序") entries[39]!.position = 0;
    });
    await f.controller.loadNextPage();
    const current = f.snapshot("one");

    assert.deepEqual(
      ids(f.controller.canvases.value).slice(0, 30),
      ids(current.canvases),
    );
    assert.equal(f.controller.total.value, current.total);
    assert.ok(f.controller.nextCursor.value?.startsWith("2:"));
    assert.equal(f.controller.directoryStale.value, false);
  });
}

test(
  "切换空间中止旧追加，忽略无视AbortSignal的迟到响应",
  { timeout: 5000 },
  async () => {
    const f = fixture();

    await f.controller.loadWorkspaces();
    const gate = deferred<CanvasCatalogPage>();
    const started = deferred<AbortSignal>();

    f.hookPages(async (request) => {
      if (request.workspaceId === "one" && request.options.cursor) {
        assert.ok(request.options.signal);
        started.resolve(request.options.signal);

        return gate.promise;
      }

      return f.snapshot(request.workspaceId, request.options);
    });
    const oldPage = f.controller.loadNextPage();
    const signal = await started.promise;

    await f.controller.selectWorkspace("two");
    assert.equal(signal.aborted, true);
    gate.resolve(f.snapshot("one", { cursor: "1:30" }));
    await oldPage;
    assert.equal(f.controller.workspaceId.value, "two");
    assert.deepEqual(ids(f.controller.canvases.value), ["two-1", "two-2"]);
    assert.equal(f.controller.total.value, 2);
    assert.equal(f.controller.paginationError.value, "");
  },
);

test(
  "切换画布不会取消同空间正常追加，迟到页仍可完成",
  { timeout: 5000 },
  async () => {
    const f = fixture();

    await f.controller.loadWorkspaces();
    const gate = deferred<CanvasCatalogPage>();
    const started = deferred<AbortSignal>();

    f.hookPages(async (request) => {
      assert.ok(request.options.signal);
      started.resolve(request.options.signal);

      return gate.promise;
    });
    const page = f.controller.loadNextPage();
    const signal = await started.promise;

    await f.controller.selectCanvas("one-2");
    assert.equal(signal.aborted, false);
    gate.resolve(f.snapshot("one", { cursor: "1:30" }));
    await page;
    assert.equal(f.document.value?.id, "one-2");
    assert.equal(f.controller.canvases.value.length, 60);
    assert.equal(f.controller.nextCursor.value, "1:60");
  },
);

for (const entry of ["最近打开", "深链接"] as const) {
  test(`${entry}第31张以后的画布按ID直达，不为定位它连续分页`, async () => {
    const f = fixture(65, entry === "最近打开" ? "one-65" : undefined);

    await f.controller.loadWorkspaces(
      entry === "深链接"
        ? { workspaceId: "one", canvasId: "one-65" }
        : undefined,
    );
    assert.equal(f.document.value?.id, "one-65");
    assert.ok(f.readCanvasIds.includes("one-65"));
    assert.equal(f.pageRequests.length, 1);
    assert.equal(f.controller.canvases.value.length, 30);
    assert.equal(
      f.controller.canvases.value.some((item) => item.id === "one-65"),
      false,
    );
    assert.deepEqual(ids(f.controller.canvasTabs.value), ["one-65"]);
  });
}

test("分页与目录刷新不能把未加载标签当删除，切空间后仍恢复完整标签", async () => {
  const f = fixture();

  await f.controller.loadWorkspaces();
  await f.controller.selectCanvas("one-65");
  f.drafts.set("one-65", "尚未保存的本地编辑");
  await f.controller.refreshDirectory();
  await f.controller.loadNextPage();
  assert.deepEqual(ids(f.controller.canvasTabs.value), ["one-1", "one-65"]);
  assert.equal(f.drafts.get("one-65"), "尚未保存的本地编辑");
  assert.deepEqual(f.invalidated, []);
  assert.deepEqual(f.historyReleased, []);
  await f.controller.selectWorkspace("two");
  await f.controller.selectWorkspace("one");
  assert.deepEqual(ids(f.controller.canvasTabs.value), ["one-1", "one-65"]);
  assert.equal(f.document.value?.id, "one-65");
  assert.deepEqual(f.invalidated, []);
});

test("刷新失败保留已知目录、编辑器与草稿并锁定修改，显式刷新成功解锁", async () => {
  const f = fixture();

  await f.controller.loadWorkspaces();
  await f.controller.selectCanvas("one-65");
  f.drafts.set("one-65", "本地草稿");
  const editor = f.document.value;
  const before = ids(f.controller.canvases.value);

  f.failPages();
  await assert.rejects(f.controller.refreshDirectory());
  assert.deepEqual(ids(f.controller.canvases.value), before);
  assert.equal(f.document.value, editor);
  assert.deepEqual(ids(f.controller.canvasTabs.value), ["one-1", "one-65"]);
  assert.equal(f.controller.directoryStale.value, true);
  assert.equal(f.controller.directoryLocked.value, true);
  await f.controller.setCanvasPinned(f.controller.canvases.value[0]!, true);
  await f.controller.moveCanvas("one-1", "one-2", "after");
  assert.equal(f.pinWrites.length, 0);
  assert.equal(f.moveWrites.length, 0);
  assert.equal(f.drafts.get("one-65"), "本地草稿");
  assert.deepEqual(f.invalidated, []);
  f.failPages(false);
  await f.controller.refreshDirectory();
  assert.equal(f.controller.directoryStale.value, false);
  assert.equal(f.controller.directoryLocked.value, false);
});

test("置顶使用精简响应并重读已加载60张范围，不取全目录且不切换编辑器", async () => {
  const f = fixture();

  await f.controller.loadWorkspaces();
  await f.controller.loadNextPage();
  const originalEditor = f.document.value;

  await f.controller.setCanvasPinned(f.controller.canvases.value[39]!, true);
  assert.deepEqual(f.pinWrites, [
    { id: "one-40", pinned: true, catalogRevision: 1 },
  ]);
  assert.equal(f.controller.canvases.value.length, 60);
  assert.equal(f.controller.canvases.value[0]!.id, "one-40");
  assert.equal(f.controller.nextCursor.value, "2:60");
  assert.equal(f.document.value, originalEditor);
  assert.deepEqual(f.legacyCalls(), { reads: 0, reorders: 0, pins: 0 });
});

test("局部移动使用目标与版本，跨页边界后重读目录并保留未加载相对顺序", async () => {
  const f = fixture();

  await f.controller.loadWorkspaces();
  await f.controller.loadNextPage();
  await f.controller.moveCanvas("one-30", "one-31", "after");
  assert.deepEqual(f.moveWrites, [
    {
      id: "one-30",
      move: { targetId: "one-31", placement: "after", catalogRevision: 1 },
    },
  ]);
  assert.deepEqual(ids(f.controller.canvases.value).slice(28, 32), [
    "one-29",
    "one-31",
    "one-30",
    "one-32",
  ]);
  assert.equal(f.controller.nextCursor.value, "2:60");
  await f.controller.loadNextPage();
  assert.deepEqual(ids(f.controller.canvases.value).slice(60), [
    "one-61",
    "one-62",
    "one-63",
    "one-64",
    "one-65",
  ]);
  assert.deepEqual(f.legacyCalls(), { reads: 0, reorders: 0, pins: 0 });
});

test("置顶组与普通组之间拒绝局部移动，保持服务端目录与当前编辑器", async () => {
  const f = fixture();

  f.remoteChange((entries) => {
    entries[0]!.pinned = true;
  });
  await f.controller.loadWorkspaces();
  const before = ids(f.controller.canvases.value);

  await f.controller.moveCanvas("one-1", "one-2", "after");
  assert.deepEqual(ids(f.controller.canvases.value), before);
  assert.equal(f.document.value?.id, "one-1");
  assert.deepEqual(ids(f.snapshot("one").canvases), before);
});

for (const mutation of ["置顶", "局部移动"] as const) {
  test(`${mutation}已提交但响应丢失时先回读确认，不重复提交`, async () => {
    const f = fixture();

    await f.controller.loadWorkspaces();
    if (mutation === "置顶") {
      const write = f.api.setCanvasPinnedSummary;

      f.api.setCanvasPinnedSummary = async (...args) => {
        await write(...args);
        throw new TypeError("网络响应丢失");
      };

      await f.controller.setCanvasPinned(f.controller.canvases.value[1]!, true);
      assert.equal(f.pinWrites.length, 1);
      assert.equal(f.controller.canvases.value[0]!.id, "one-2");
      assert.equal(f.controller.canvases.value[0]!.pinned, true);
    } else {
      const write = f.api.moveCanvas;

      f.api.moveCanvas = async (...args) => {
        await write(...args);
        throw new TypeError("网络响应丢失");
      };

      await f.controller.moveCanvas("one-1", "one-2", "after");
      assert.equal(f.moveWrites.length, 1);
      assert.deepEqual(ids(f.controller.canvases.value).slice(0, 2), [
        "one-2",
        "one-1",
      ]);
    }

    assert.ok(f.pageRequests.length > 1);
    assert.equal(f.controller.directoryStale.value, false);
    assert.equal(f.errors.length, 0);
    assert.deepEqual(f.legacyCalls(), { reads: 0, reorders: 0, pins: 0 });
  });
}

for (const mutation of ["新建", "删除", "恢复"] as const) {
  test(`${mutation}后重读已加载范围与游标，不能拼接不同版本页`, async () => {
    const f = fixture();

    await f.controller.loadWorkspaces();
    await f.controller.loadNextPage();
    if (mutation === "新建") await f.controller.createCanvas();
    if (mutation === "删除")
      await f.controller.deleteCanvas(f.controller.canvases.value[9]!);
    if (mutation === "恢复") {
      f.remoteChange((entries) => {
        entries.push({ ...canvas(66), position: 0 });
      });
      await f.controller.refreshAfterRestore();
    }

    assert.equal(f.controller.canvases.value.length, 60);
    assert.equal(f.controller.nextCursor.value, "2:60");
    assert.deepEqual(
      ids(f.controller.canvases.value),
      ids(f.snapshot("one", { limit: 60 }).canvases),
    );
    assert.equal(f.controller.total.value, mutation === "删除" ? 64 : 66);
    assert.equal(f.legacyCalls().reads, 0);
    if (mutation === "新建") {
      assert.equal(f.document.value?.id, "created");
      assert.ok(ids(f.controller.canvasTabs.value).includes("created"));
    }
  });
}

test("删除工作空间清理已知但未在已加载页中的画布，不影响其他空间标签", async () => {
  const f = fixture();

  await f.controller.loadWorkspaces();
  await f.controller.selectCanvas("one-65");
  f.drafts.set("one-65", "被删除空间的草稿");
  await f.controller.deleteWorkspace();
  assert.equal(f.controller.workspaceId.value, "two");
  assert.ok(f.invalidated.includes("one-65"));
  assert.equal(f.drafts.has("one-65"), false);
  assert.equal(
    f.invalidated.some((id) => id.startsWith("two-")),
    false,
  );
  assert.deepEqual(ids(f.controller.canvasTabs.value), ["two-1"]);
});

test("深链接画布实际属于另一空间时拒绝归入目标空间标签", async () => {
  const f = fixture();

  await assert.rejects(
    f.controller.loadWorkspaces({ workspaceId: "one", canvasId: "two-2" }),
  );
  assert.equal(ids(f.controller.canvasTabs.value).includes("two-2"), false);
  assert.equal(f.document.value?.id === "two-2", false);
  assert.equal(f.pageRequests.length, 1);
});

test("按ID重开已知标签遇到网络错误时保留标签与草稿，可再次选择重试", async () => {
  const f = fixture();

  await f.controller.loadWorkspaces();
  await f.controller.selectCanvas("one-65");
  f.drafts.set("one-65", "后台待保存草稿");
  await f.controller.selectCanvas("one-1");
  const read = f.api.readCanvas;

  f.api.readCanvas = async (id) => {
    if (id === "one-65") throw new ApiError(503, "UNAVAILABLE", "暂时不可读");

    return read(id);
  };

  await f.controller.selectCanvas("one-65");
  assert.deepEqual(ids(f.controller.canvasTabs.value), ["one-1", "one-65"]);
  assert.equal(f.drafts.get("one-65"), "后台待保存草稿");
  assert.deepEqual(f.invalidated, []);
  assert.equal(f.errors.length, 1);
  f.api.readCanvas = read;
  await f.controller.selectCanvas("one-65");
  assert.equal(f.document.value?.id, "one-65");
});
