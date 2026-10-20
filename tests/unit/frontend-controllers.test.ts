import { test } from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";
import { api, ApiError } from "../../src/lib/api";
import { useCanvasDocument } from "../../src/composables/useCanvasDocument";
import { useWorkspaceNavigation } from "../../src/composables/useWorkspaceNavigation";
import {
  useWorkspaceDirectory,
  type WorkspaceDirectoryDependencies,
} from "../../src/composables/useWorkspaceDirectory";
import { useOperation } from "../../src/composables/useOperation";
import type {
  CanvasDocument,
  CanvasMeta,
  Workspace,
} from "../../shared/contracts";

const canvas = (id: string, position: number): CanvasDocument => ({
  id,
  position,
  workspaceId: "space",
  name: id,
  revision: 0,
  createdAt: "",
  updatedAt: "",
  scene: { elements: [], appState: {}, files: {} },
});
const workspace: Workspace = {
  id: "space",
  name: "space",
  catalogRevision: 0,
  createdAt: "",
  updatedAt: "",
};

test("HTTP port refuses successful HTML/null responses instead of returning a forged DTO", async () => {
  const original = globalThis.fetch;

  try {
    for (const body of ["<html>error</html>", "null"]) {
      globalThis.fetch = (async () => new Response(body)) as typeof fetch;
      await assert.rejects(api("/api/bootstrap"), { code: "INVALID_RESPONSE" });
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("document controller loads scenes independently of the lazy account library", async () => {
  let loaded = 0;
  let libraryReads = 0;
  const document = useCanvasDocument({
    api: {
      readCanvas: async (id) => canvas(id, 0),
      readLibrary: async () => {
        libraryReads++;
        throw new Error("offline");
      },
    },
    ownerId: () => "alice",
    onLoaded: () => {
      loaded++;
    },
  });

  try {
    await document.loadCanvas("original");
    await document.loadCanvas("replacement");
    assert.equal(document.document.value?.id, "replacement");
    assert.equal(document.library.value, undefined);
    assert.equal(libraryReads, 0);
    assert.equal(loaded, 2);
  } finally {
    document.reset();
  }
});

test("navigation conflict adopts the winning revision without retrying or selecting another canvas", async () => {
  let writes = 0;
  let reads = 0;
  const navigation = useWorkspaceNavigation({
    readNavigation: async () => ({
      revision: ++reads,
      lastWorkspaceId: "space",
      lastCanvasId: "other",
      workspaces: [],
    }),
    recordOpened: async () => {
      writes++;
      throw new ApiError(409, "NAVIGATION_CONFLICT", "conflict");
    },
  });

  await navigation.recordOpened("current");
  assert.equal(writes, 1);
  assert.equal(navigation.navigation.value?.revision, 2);
  assert.match(navigation.navigationNotice.value, /当前画布已打开/);
});

function directoryFixture() {
  let catalog: CanvasMeta[] = [canvas("first", 0), canvas("second", 1)];
  let catalogFails = false;
  let flushFails = false;
  const operation = useOperation(() => false);
  const document = useCanvasDocument({
    api: {
      readCanvas: async (id) => canvas(id, 0),
      readLibrary: async () => ({ items: [], revision: 0 }),
    },
    ownerId: () => "alice",
    onLoaded() {},
  });
  const navigation = useWorkspaceNavigation({
    readNavigation: async () => ({
      revision: 0,
      lastWorkspaceId: null,
      lastCanvasId: null,
      workspaces: [],
    }),
    recordOpened: async (canvasId) => ({
      revision: 1,
      lastWorkspaceId: "space",
      lastCanvasId: canvasId,
      workspaces: [],
    }),
  });
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected API action");
  };
  const api: WorkspaceDirectoryDependencies["api"] = {
    listWorkspaces: async () => [workspace],
    readCatalog: async () => {
      if (catalogFails) throw new Error("catalog unavailable");

      return { canvases: catalog, catalogRevision: 0 };
    },
    reorder: async () => {
      throw new ApiError(409, "CATALOG_CONFLICT", "conflict");
    },
    setCanvasPinned: unused,
    createWorkspace: unused,
    renameWorkspace: unused,
    deleteWorkspace: unused,
    createCanvas: unused,
    renameCanvas: unused,
    deleteCanvas: unused,
  };
  const directory = useWorkspaceDirectory({
    api,
    navigationController: navigation,
    canvasDocument: document,
    editor: {
      flush: async () => {
        if (flushFails) throw new Error("unsaved scene");
      },
    },
    interactionLocked: operation.busy,
    run: operation.run,
    dialogs: { prompt: async () => null, confirm: async () => false },
  });

  return {
    api,
    directory,
    document,
    operation,
    failCatalog: () => {
      catalogFails = true;
    },
    failFlush: () => {
      flushFails = true;
    },
    remoteOrder: (ids: string[]) => {
      catalog = ids.map((id) => catalog.find((item) => item.id === id)!);
    },
  };
}

// 以下置顶用例使用真实目录控制器与替代 API；只证明客户端协调，不证明云端写入。
for (const status of [409, 503]) {
  test(`置顶写入${status}失败后回读目标状态，不自动重试或切换编辑器`, async () => {
    const f = directoryFixture();
    let writes = 0;

    await f.directory.loadWorkspaces();
    f.api.setCanvasPinned = async () => {
      writes++;
      throw new ApiError(status, "PIN_FAILED", "置顶失败");
    };

    f.api.readCatalog = async () => ({
      canvases: [{ ...canvas("second", 1), pinned: true }, canvas("first", 0)],
      catalogRevision: 4,
    });
    await f.directory.setCanvasPinned(f.directory.canvases.value[1]!, true);
    assert.equal(writes, 1);
    assert.equal(f.directory.canvases.value[0]!.pinned, true);
    assert.equal(f.document.document.value?.id, "first");
    assert.equal(f.directory.directoryStale.value, false);
    assert.equal(Boolean(f.operation.error.value), false);
  });
}

test("置顶写入未确认前不乐观重排，失败回读未达目标则保留原状态并提示", async () => {
  const f = directoryFixture();

  await f.directory.loadWorkspaces();
  let reject!: (error: Error) => void;
  let writes = 0;

  f.api.setCanvasPinned = () => {
    writes++;

    return new Promise((_, fail) => {
      reject = fail;
    });
  };

  const action = f.directory.setCanvasPinned(
    f.directory.canvases.value[1]!,
    true,
  );

  await Promise.resolve();
  assert.deepEqual(
    f.directory.canvases.value.map((item) => item.id),
    ["first", "second"],
  );
  assert.equal(Boolean(f.directory.canvases.value[1]!.pinned), false);
  reject(new ApiError(503, "PIN_FAILED", "置顶失败"));
  await action;
  assert.equal(writes, 1);
  assert.equal(Boolean(f.operation.error.value), true);
  assert.equal(Boolean(f.directory.canvases.value[1]!.pinned), false);
  assert.equal(f.document.document.value?.id, "first");
});

test("置顶失败且回读失败会锁定目录，不能继续写入未知版本", async () => {
  const f = directoryFixture();

  await f.directory.loadWorkspaces();
  let writes = 0;

  f.api.setCanvasPinned = async () => {
    writes++;
    throw new ApiError(503, "PIN_FAILED", "置顶失败");
  };

  f.failCatalog();
  const target = f.directory.canvases.value[1]!;

  await f.directory.setCanvasPinned(target, true);
  assert.equal(f.directory.directoryStale.value, true);
  assert.equal(f.directory.directoryLocked.value, true);
  await f.directory.setCanvasPinned(target, true);
  assert.equal(writes, 1);
});

for (const outcome of ["success", "failure"] as const) {
  test(`账号重置后旧置顶${outcome}响应不得覆盖或锁定新目录`, async () => {
    const f = directoryFixture();

    await f.directory.loadWorkspaces();
    let resolve!: (value: {
      canvases: CanvasMeta[];
      catalogRevision: number;
    }) => void;
    let reject!: (reason: Error) => void;

    f.api.setCanvasPinned = () =>
      new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      });
    const action = f.directory.setCanvasPinned(
      f.directory.canvases.value[1]!,
      true,
    );

    await Promise.resolve();
    f.directory.reset();
    f.document.reset();
    f.api.listWorkspaces = async () => [{ ...workspace, id: "new-space" }];
    f.api.readCatalog = async () => ({
      canvases: [{ ...canvas("new-canvas", 0), workspaceId: "new-space" }],
      catalogRevision: 7,
    });
    await f.directory.loadWorkspaces();
    if (outcome === "success") {
      resolve({
        canvases: [{ ...canvas("second", 1), pinned: true }],
        catalogRevision: 1,
      });
    } else {
      reject(new ApiError(503, "OLD_ACCOUNT_FAILURE", "旧账号失败"));
    }

    await action;
    assert.equal(f.directory.workspaceId.value, "new-space");
    assert.deepEqual(
      f.directory.canvases.value.map((item) => item.id),
      ["new-canvas"],
    );
    assert.equal(f.directory.directoryStale.value, false);
    assert.equal(f.directory.directoryLocked.value, false);
    assert.equal(Boolean(f.operation.error.value), false);
  });
}

test(
  "置顶失败回读尚未完成时切换账号，旧回读失败不得锁定新目录",
  { timeout: 5000 },
  async () => {
    const f = directoryFixture();

    await f.directory.loadWorkspaces();
    let begin!: () => void;
    let rejectRead!: (error: Error) => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });

    f.api.setCanvasPinned = async () => {
      throw new ApiError(503, "PIN_FAILED", "旧置顶失败");
    };

    f.api.readCatalog = () => {
      begin();

      return new Promise((_, reject) => {
        rejectRead = reject;
      });
    };

    const action = f.directory.setCanvasPinned(
      f.directory.canvases.value[1]!,
      true,
    );

    await started;
    f.directory.reset();
    f.document.reset();
    f.api.listWorkspaces = async () => [{ ...workspace, id: "new-space" }];
    f.api.readCatalog = async () => ({
      canvases: [{ ...canvas("new-canvas", 0), workspaceId: "new-space" }],
      catalogRevision: 7,
    });
    try {
      await f.directory.loadWorkspaces();
    } finally {
      rejectRead(new ApiError(503, "OLD_READ_FAILED", "旧账号回读失败"));
    }

    await action;
    assert.equal(f.directory.workspaceId.value, "new-space");
    assert.deepEqual(
      f.directory.canvases.value.map((item) => item.id),
      ["new-canvas"],
    );
    assert.equal(f.directory.directoryStale.value, false);
    assert.equal(f.directory.directoryLocked.value, false);
    assert.equal(Boolean(f.operation.error.value), false);
  },
);

test("directory refuses switching past a failed editor save barrier", async () => {
  const { directory, document, operation, failFlush } = directoryFixture();

  await directory.loadWorkspaces();
  failFlush();
  await directory.selectCanvas("second");
  assert.equal(document.document.value?.id, "first");
  assert.equal(operation.error.value, "unsaved scene");
});

test("catalog conflict restores server order without replacing the loaded editor; failed reconciliation locks mutations", async () => {
  const { directory, document, operation, failCatalog } = directoryFixture();

  await directory.loadWorkspaces();
  await directory.reorderCanvas(["second", "first"]);
  assert.deepEqual(
    directory.canvases.value.map((item) => item.id),
    ["first", "second"],
  );
  assert.equal(document.document.value?.id, "first");
  assert.match(operation.error.value, /其他页面更新/);
  failCatalog();
  await directory.reorderCanvas(["second", "first"]);
  assert.equal(directory.directoryStale.value, true);
  assert.equal(directory.directoryLocked.value, true);
  assert.deepEqual(
    directory.canvases.value.map((item) => item.id),
    ["first", "second"],
  );
});

test("late account workspace lists cannot publish after reset and a new account load", async () => {
  const fixture = directoryFixture();
  let resolveOld!: (value: Workspace[]) => void;
  const oldList = new Promise<Workspace[]>((resolve) => {
    resolveOld = resolve;
  });
  let requests = 0;

  fixture.api.listWorkspaces = async () =>
    ++requests === 1
      ? oldList
      : [{ ...workspace, id: "new-space", name: "new account space" }];
  try {
    const old = fixture.directory.loadWorkspaces();

    fixture.directory.reset();
    fixture.document.reset();
    await fixture.directory.loadWorkspaces();
    resolveOld([{ ...workspace, name: "private old account space" }]);
    await old;
    assert.equal(
      fixture.directory.workspaces.value[0]?.name,
      "new account space",
    );
    assert.equal(fixture.directory.workspaceId.value, "new-space");
  } finally {
    fixture.document.reset();
  }
});

test("explicit canvas navigation bypasses recent tabs and fails closed on a disappearing target", async () => {
  const fixture = directoryFixture();

  try {
    await fixture.directory.loadWorkspaces();
    assert.equal(fixture.document.document.value?.id, "first");
    await fixture.directory.loadWorkspaces({
      workspaceId: workspace.id,
      canvasId: "second",
    });
    assert.equal(fixture.document.document.value?.id, "second");
    fixture.document.reset();
    let reads = 0;

    fixture.api.readCatalog = async () => ({
      canvases:
        ++reads === 1
          ? [canvas("first", 0), canvas("second", 1)]
          : [canvas("first", 0)],
      catalogRevision: reads,
    });
    await assert.rejects(
      fixture.directory.loadWorkspaces({
        workspaceId: workspace.id,
        canvasId: "second",
      }),
      /目标画布不可访问/,
    );
    assert.equal(fixture.document.document.value, undefined);
    assert.equal(reads, 2);
  } finally {
    fixture.document.reset();
  }
});
