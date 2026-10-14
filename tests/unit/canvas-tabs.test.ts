import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";
import { useCanvasTabs } from "../../src/composables/useCanvasTabs";
import { useWorkspaceDirectory } from "../../src/composables/useWorkspaceDirectory";
import { CanvasResources } from "../../src/lib/canvasResources";
import type {
  CanvasDocument,
  CanvasMeta,
  Workspace,
} from "../../shared/contracts";

Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: { getItem: () => "canvas-tabs-test", setItem: () => {} },
});

const canvas = (id: string, workspaceId = "one"): CanvasDocument => ({
  id,
  workspaceId,
  name: id,
  position: 0,
  revision: 0,
  createdAt: "",
  updatedAt: "",
  scene: { elements: [], appState: {}, files: {} },
});

test("tabs deduplicate, choose a neighbor, reconcile deletions and reset account memory", () => {
  const tabs = useCanvasTabs();

  assert.equal(tabs.active("one"), undefined);
  for (const id of ["a", "b", "c", "b"]) tabs.open("one", id);
  assert.deepEqual(tabs.ids("one"), ["a", "b", "c"]);
  tabs.close("one", "b");
  assert.equal(tabs.active("one"), "c");
  tabs.reconcile("one", ["a"]);
  assert.equal(tabs.active("one"), "a");
  tabs.open("two", "d");
  tabs.close("one", "a");
  assert.equal(tabs.active("one"), null);
  assert.equal(tabs.active("two"), "d");
  tabs.reset();
  assert.deepEqual(tabs.ids("two"), []);
  assert.equal(tabs.active("one"), undefined);
});

function directoryFixture() {
  const workspaces: Workspace[] = ["one", "two"].map((id) => ({
    id,
    name: id,
    catalogRevision: 0,
    createdAt: "",
    updatedAt: "",
  }));
  let catalog = [canvas("a"), canvas("b"), canvas("c", "two")];
  const document = ref<CanvasDocument>();
  let checkpointFailure = false;
  let checkpointCalls = 0;
  let checkpointGate: Promise<void> | undefined;
  const errors: unknown[] = [];
  const selected = (id: string) => catalog.find((item) => item.id === id)!;
  const controller = useWorkspaceDirectory({
    api: {
      listWorkspaces: async () => workspaces,
      readCatalog: async (id) => ({
        canvases: catalog.filter((item) => item.workspaceId === id),
        catalogRevision: 0,
      }),
      createCanvas: async (id, name) => {
        const created = { ...canvas("new", id), name };

        catalog.push(created);

        return created;
      },
      renameCanvas: async (id, name) => {
        selected(id).name = name;

        return selected(id);
      },
      deleteCanvas: async (id) => {
        catalog = catalog.filter((item) => item.id !== id);
      },
      createWorkspace: async () => workspaces[0]!,
      renameWorkspace: async () => workspaces[0]!,
      deleteWorkspace: async () => {},
      reorder: async () => ({ canvases: catalog, catalogRevision: 0 }),
    },
    navigationController: {
      navigation: ref(null),
      refreshNavigationQuietly: async () => {},
      recordOpened: async () => {},
    },
    canvasDocument: {
      document,
      releaseEditorHistory: () => {},
      loadCanvas: async (id) => {
        document.value = structuredClone(selected(id));
      },
      clearDocument: () => {
        document.value = undefined;
      },
      renameLoadedCanvas: (id, name) => {
        if (document.value?.id === id) document.value.name = name;
      },
      invalidateCanvas: (id) => {
        if (document.value?.id !== id) return false;
        document.value = undefined;

        return true;
      },
    },
    editor: {
      checkpoint: async () => {
        checkpointCalls++;
        await checkpointGate;
        if (checkpointFailure) throw new Error("draft unavailable");
      },
      flush: async () => {},
    },
    interactionLocked: ref(false),
    run: async (action) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    },
    dialogs: { prompt: async () => "renamed", confirm: async () => true },
  });

  return {
    controller,
    document,
    errors,
    checkpointCalls: () => checkpointCalls,
    failCheckpoint: () => {
      checkpointFailure = true;
    },
    holdCheckpoint() {
      let release!: () => void;

      checkpointGate = new Promise<void>((resolve) => {
        release = resolve;
      });

      return release;
    },
  };
}

test("directory keeps each workspace's tabs and explicitly closed last tab until reopened", async () => {
  const { controller, document } = directoryFixture();

  await controller.loadWorkspaces();
  await controller.selectCanvas("b");
  await controller.selectWorkspace("two");
  assert.deepEqual(
    controller.canvasTabs.value.map((item) => item.id),
    ["c"],
  );
  await controller.selectWorkspace("one");
  assert.deepEqual(
    controller.canvasTabs.value.map((item) => item.id),
    ["a", "b"],
  );
  assert.equal(document.value?.id, "b");
  await controller.closeCanvasTab("a");
  await controller.closeCanvasTab("b");
  assert.equal(document.value, undefined);
  await controller.selectWorkspace("two");
  await controller.selectWorkspace("one");
  assert.equal(document.value, undefined);
  assert.equal(controller.canvases.value.length, 2);
  await controller.selectCanvas("a");
  assert.equal(document.value?.id, "a");
  controller.reset();
  assert.equal(controller.canvasTabs.value.length, 0);
});

test("clicking the still-visible tab cancels another pending tab switch", async () => {
  const { controller, document, holdCheckpoint } = directoryFixture();

  await controller.loadWorkspaces();
  const release = holdCheckpoint();
  const first = controller.selectCanvas("b");
  const last = controller.selectCanvas("a");

  release();
  await Promise.all([first, last]);
  assert.equal(document.value?.id, "a");
  assert.deepEqual(
    controller.canvasTabs.value.map((item) => item.id),
    ["a"],
  );
});

test("closing the active view protects its draft; a failed checkpoint leaves the tab open", async () => {
  const fixture = directoryFixture();
  const { controller, document } = fixture;

  await controller.loadWorkspaces();
  await controller.selectCanvas("b");
  await controller.closeCanvasTab("b");
  assert.equal(document.value?.id, "a");
  const calls = fixture.checkpointCalls();

  await controller.selectCanvas("b");
  await controller.closeCanvasTab("a");
  assert.equal(
    fixture.checkpointCalls(),
    calls + 1,
    "background tab close does not capture the active editor",
  );
  fixture.failCheckpoint();
  await controller.closeCanvasTab("b");
  assert.equal(document.value?.id, "b");
  assert.deepEqual(
    controller.canvasTabs.value.map((item) => item.id),
    ["b"],
  );
  assert.equal(fixture.errors.length, 1);
});

test("new and renamed files synchronize tabs; deleting active selects its adjacent open tab", async () => {
  const { controller, document } = directoryFixture();

  await controller.loadWorkspaces();
  await controller.selectCanvas("b");
  await controller.renameCanvas(controller.canvases.value[1] as CanvasMeta);
  assert.equal(controller.canvasTabs.value[1]?.name, "renamed");
  await controller.createCanvas();
  assert.equal(document.value?.id, "new");
  await controller.deleteCanvas(
    controller.canvases.value.find((item) => item.id === "new")!,
  );
  assert.equal(document.value?.id, "b");
  assert.deepEqual(
    controller.canvasTabs.value.map((item) => item.id),
    ["a", "b"],
  );
});

test("clean scene eviction preserves lightweight per-canvas editor context without retaining the scene", async () => {
  const resources = new CanvasResources(
    "tabs-context",
    {
      readCanvas: async (id) => canvas(id),
      readLibrary: async () => ({ items: [], revision: 0 }),
    },
    () => {},
  );

  try {
    const first = await resources.open("a", () => {});

    first.editorContext = {
      activeTool: { type: "ellipse" },
      viewModeEnabled: false,
      viewport: { scrollX: 320, scrollY: -120, zoom: { value: 1 as never } },
    };
    for (const id of ["b", "c", "d", "e", "f"]) {
      resources.setActive(id);
      await resources.open(id, () => {});
    }

    assert.equal(resources.canvases.has("a"), false);
    const reopened = await resources.open("a", () => {});

    assert.deepEqual(reopened.editorContext, first.editorContext);
    await resources.invalidate("a");
    assert.equal(resources.canvases.has("a"), false);
  } finally {
    resources.dispose();
  }
});
