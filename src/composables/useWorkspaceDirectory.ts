import { computed, ref, shallowReadonly, type Ref } from "vue";
import type {
  Workspace,
  CanvasMeta,
  CanvasCatalog,
} from "../../shared/contracts";
import { ApiError } from "../lib/api";
import type { WorkspaceApi } from "../lib/workspaceApi";
import type { NavigationController } from "./useWorkspaceNavigation";
import type { CanvasDocumentController } from "./useCanvasDocument";
import type { SaveBarrier } from "../lib/editor";
import type { promptDialog, confirmDialog } from "../lib/dialogs";

export interface WorkspaceDirectoryDependencies {
  api: Pick<
    WorkspaceApi,
    | "listWorkspaces"
    | "readCatalog"
    | "reorder"
    | "createWorkspace"
    | "renameWorkspace"
    | "deleteWorkspace"
    | "createCanvas"
    | "renameCanvas"
    | "deleteCanvas"
  >;
  navigationController: Pick<
    NavigationController,
    "navigation" | "refreshNavigationQuietly" | "recordOpened"
  >;
  canvasDocument: Pick<
    CanvasDocumentController,
    "document" | "loadCanvas" | "clearDocument" | "renameLoadedCanvas"
  >;
  editor: SaveBarrier;
  interactionLocked: Readonly<Ref<boolean>>;
  run(action: () => Promise<void>): Promise<void>;
  dialogs: { prompt: typeof promptDialog; confirm: typeof confirmDialog };
}

export interface WorkspaceDirectoryController {
  workspaces: Readonly<Ref<readonly Workspace[]>>;
  canvases: Readonly<Ref<readonly CanvasMeta[]>>;
  workspaceId: Readonly<Ref<string>>;
  currentWorkspace: Readonly<Ref<Workspace | undefined>>;
  directoryStale: Readonly<Ref<boolean>>;
  directoryLocked: Readonly<Ref<boolean>>;
  reset(): void;
  refreshDirectory(): Promise<void>;
  loadWorkspaces(): Promise<void>;
  reorderCanvas(ids: string[]): Promise<void>;
  selectWorkspace(id: string): Promise<void>;
  selectCanvas(id: string): Promise<void>;
  createWorkspace(): Promise<void>;
  renameWorkspace(): Promise<void>;
  deleteWorkspace(): Promise<void>;
  createCanvas(): Promise<void>;
  renameCanvas(canvas: CanvasMeta): Promise<void>;
  deleteCanvas(canvas: CanvasMeta): Promise<void>;
}

export function useWorkspaceDirectory({
  api,
  navigationController,
  canvasDocument,
  editor,
  interactionLocked,
  run,
  dialogs,
}: WorkspaceDirectoryDependencies): WorkspaceDirectoryController {
  const workspaces = ref<Workspace[]>([]);
  const canvases = ref<CanvasMeta[]>([]);
  const workspaceId = ref("");

  type Directory = CanvasCatalog;

  const catalogRevision = ref(0);
  const directoryStale = ref(false);
  const directoryLocked = computed(
    () => interactionLocked.value || directoryStale.value,
  );
  const currentWorkspace = computed(() =>
    workspaces.value.find((item) => item.id === workspaceId.value),
  );
  const { navigation, refreshNavigationQuietly, recordOpened } =
    navigationController;
  const { document, loadCanvas } = canvasDocument;
  const flush = () => editor.flush();

  function reset() {
    workspaces.value = [];
    canvases.value = [];
    workspaceId.value = "";
    catalogRevision.value = 0;
    directoryStale.value = false;
  }

  async function readDirectory(id: string) {
    return api.readCatalog(id);
  }

  function setDirectory(id: string, data: Directory) {
    workspaceId.value = id;
    canvases.value = data.canvases;
    catalogRevision.value = data.catalogRevision;
    directoryStale.value = false;
  }

  async function refreshDirectory() {
    if (!workspaceId.value) return;
    try {
      setDirectory(workspaceId.value, await readDirectory(workspaceId.value));
    } catch (error) {
      directoryStale.value = true;
      throw new Error("未能确认最新画布列表，请重新加载列表后再操作。", {
        cause: error,
      });
    }
  }

  async function loadWorkspace(
    id: string,
    preferred?: string | null,
    explicit = false,
  ) {
    const data = await readDirectory(id);
    const remembered =
      preferred ??
      navigation.value?.workspaces.find((item) => item.workspaceId === id)
        ?.lastCanvasId;
    const selected =
      data.canvases.find((item) => item.id === remembered) ?? data.canvases[0];

    // Only replace the current editor once the selected scene and library both load.
    if (selected) await loadCanvas(selected.id);
    else {
      canvasDocument.clearDocument();
    }

    setDirectory(id, data);
    if (selected && (explicit || !navigation.value?.lastCanvasId))
      await recordOpened(selected.id);
  }

  async function loadWorkspaces() {
    const [data] = await Promise.all([
      api.listWorkspaces(),
      refreshNavigationQuietly(),
    ]);
    const entries = data;

    workspaces.value = entries;
    if (!entries.length) {
      reset();
      canvasDocument.clearDocument("没有工作空间");

      return;
    }

    const remembered = entries.find(
      (item) => item.id === navigation.value?.lastWorkspaceId,
    );

    // A deleted/empty recent space falls back to the first nonempty space, without creating data.
    if (remembered) {
      const recentDirectory = await readDirectory(remembered.id);

      if (recentDirectory.canvases.length) {
        await loadWorkspace(remembered.id, navigation.value?.lastCanvasId);

        return;
      }
    }

    for (const entry of entries) {
      const listing = await readDirectory(entry.id);

      if (listing.canvases.length) {
        await loadWorkspace(entry.id, listing.canvases[0]!.id);

        return;
      }
    }

    await loadWorkspace(remembered?.id ?? entries[0]!.id);
  }

  async function reorderCanvas(ids: string[]) {
    if (
      directoryLocked.value ||
      ids.every((id, i) => id === canvases.value[i]?.id)
    )
      return;
    const previous = [...canvases.value];
    const ordered = ids.map((id) =>
      previous.find((canvas) => canvas.id === id)!,
    );

    await run(async () => {
      canvases.value = ordered;
      try {
        setDirectory(
          workspaceId.value,
          await api.reorder(workspaceId.value, ids, catalogRevision.value),
        );
      } catch (cause) {
        canvases.value = previous;
        // A response can be lost after commit. Always re-read instead of sending the old order again.
        await refreshDirectory();
        const accepted =
          canvases.value
            .map((item) => item.id)
            .every((id, i) => id === ids[i]) &&
          canvases.value.length === ids.length;

        if (!accepted)
          throw new Error(
            cause instanceof ApiError && cause.code === "CATALOG_CONFLICT"
              ? "列表已在其他页面更新，请重新排序。"
              : "排序未完成，已恢复服务端列表，请重试。",
          );
      }
    });
  }

  async function selectWorkspace(id: string) {
    if (interactionLocked.value) return;
    if (id === workspaceId.value) return;
    await run(async () => {
      await flush();
      await refreshNavigationQuietly();
      await loadWorkspace(id, undefined, true);
    });
  }

  async function selectCanvas(id: string) {
    if (id === document.value?.id) return;
    await run(async () => {
      await flush();
      await loadCanvas(id);
      await recordOpened(id);
    });
  }

  async function createWorkspace() {
    if (interactionLocked.value) return;
    const name = await dialogs.prompt({
      title: "新建工作空间",
      label: "工作空间名称",
      initialValue: "新的工作空间",
      confirmLabel: "创建",
    });

    if (!name) return;
    await run(async () => {
      await flush();
      const workspace = await api.createWorkspace(name);

      workspaces.value.push(workspace);
      await refreshNavigationQuietly();
      await loadWorkspace(workspace.id, undefined, true);
    });
  }

  async function renameWorkspace() {
    const name = await dialogs.prompt({
      title: "重命名工作空间",
      label: "工作空间名称",
      initialValue: currentWorkspace.value?.name,
      confirmLabel: "保存名称",
    });

    if (!name || name === currentWorkspace.value?.name) return;
    await run(async () => {
      const workspace = await api.renameWorkspace(workspaceId.value, name);

      workspaces.value = workspaces.value.map((item) =>
        item.id === workspace.id ? workspace : item,
      );
    });
  }

  async function deleteWorkspace() {
    if (interactionLocked.value) return;
    if (
      !(await dialogs.confirm({
        title: "删除工作空间",
        message: `删除「${currentWorkspace.value?.name}」及其中所有画布？此操作无法撤销。`,
        confirmLabel: "删除工作空间",
        danger: true,
      }))
    )
      return;
    await run(async () => {
      await flush();
      await api.deleteWorkspace(workspaceId.value);
      canvasDocument.clearDocument();
      workspaceId.value = "";
      canvases.value = [];
      await loadWorkspaces();
    });
  }

  async function createCanvas() {
    if (directoryLocked.value || !workspaceId.value) return;
    const name = await dialogs.prompt({
      title: "新建画布",
      label: "画布名称",
      initialValue: "未命名画布",
      confirmLabel: "创建",
    });

    if (!name) return;
    await run(async () => {
      await flush();
      let canvas: CanvasMeta;

      try {
        canvas = await api.createCanvas(
          workspaceId.value,
          name,
          catalogRevision.value,
        );
      } catch (cause) {
        await refreshDirectory();
        throw cause;
      }

      await refreshDirectory();
      await loadCanvas(canvas.id);
      await recordOpened(canvas.id);
    });
  }

  async function renameCanvas(canvas: CanvasMeta) {
    const name = await dialogs.prompt({
      title: "重命名画布",
      label: "画布名称",
      initialValue: canvas.name,
      confirmLabel: "保存名称",
    });

    if (!name || name === canvas.name) return;
    await run(async () => {
      await flush();
      const updated = await api.renameCanvas(canvas.id, name);

      canvases.value = canvases.value.map((item) =>
        item.id === canvas.id ? updated : item,
      );
      canvasDocument.renameLoadedCanvas(canvas.id, updated.name);
    });
  }

  async function deleteCanvas(canvas: CanvasMeta) {
    if (directoryLocked.value) return;
    if (
      !(await dialogs.confirm({
        title: "删除画布",
        message: `删除画布「${canvas.name}」？此操作无法撤销。`,
        confirmLabel: "删除画布",
        danger: true,
      }))
    )
      return;
    await run(async () => {
      await flush();
      let failure: unknown;

      try {
        await api.deleteCanvas(canvas.id, catalogRevision.value);
      } catch (cause) {
        failure = cause;
      }

      await refreshDirectory();
      if (failure && canvases.value.some((item) => item.id === canvas.id))
        throw failure;
      if (document.value?.id === canvas.id) {
        canvasDocument.clearDocument();
        await refreshNavigationQuietly();
        await loadWorkspace(workspaceId.value, canvases.value[0]?.id);
      }
    });
  }

  return {
    workspaces: shallowReadonly(workspaces),
    canvases: shallowReadonly(canvases),
    workspaceId: shallowReadonly(workspaceId),
    currentWorkspace,
    directoryStale: shallowReadonly(directoryStale),
    directoryLocked,
    reset,
    refreshDirectory,
    loadWorkspaces,
    reorderCanvas,
    selectWorkspace,
    selectCanvas,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    createCanvas,
    renameCanvas,
    deleteCanvas,
  };
}
