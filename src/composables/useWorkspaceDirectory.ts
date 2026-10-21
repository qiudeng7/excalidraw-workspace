import { computed, ref, shallowReadonly, type Ref } from "vue";
import type { Workspace, CanvasMeta, CanvasCatalog } from "#shared/contracts";
import { ApiError } from "~/lib/api";
import type { WorkspaceApi } from "~/lib/workspaceApi";
import type { NavigationController } from "~/composables/useWorkspaceNavigation";
import type { CanvasDocumentController } from "~/composables/useCanvasDocument";
import type { SaveBarrier } from "~/lib/editor";
import type { promptDialog, confirmDialog } from "~/lib/dialogs";
import { useCanvasTabs } from "~/composables/useCanvasTabs";

export interface WorkspaceDirectoryDependencies {
  api: Partial<
    Pick<
      WorkspaceApi,
      "readCatalogPage" | "moveCanvas" | "setCanvasPinnedSummary" | "readCanvas"
    >
  > &
    Pick<
      WorkspaceApi,
      | "listWorkspaces"
      | "readCatalog"
      | "reorder"
      | "setCanvasPinned"
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
  canvasDocument: Partial<Pick<CanvasDocumentController, "restoreCanvas">> &
    Pick<
      CanvasDocumentController,
      | "document"
      | "loadCanvas"
      | "clearDocument"
      | "renameLoadedCanvas"
      | "invalidateCanvas"
      | "releaseEditorHistory"
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
  total: Readonly<Ref<number>>;
  nextCursor: Readonly<Ref<string | null>>;
  loadingMore: Readonly<Ref<boolean>>;
  paginationError: Readonly<Ref<string>>;
  refreshing: Readonly<Ref<boolean>>;
  /** 同空间去重追加；冲突刷新已加载范围，失败保留已有页并等待显式重试。 */
  loadNextPage(): Promise<void>;
  /** 局部移动，写响应丢失时回读确认而不重复提交。 */
  moveCanvas(
    canvasId: string,
    targetId: string,
    placement: "before" | "after",
  ): Promise<void>;
  canvasTabs: Readonly<Ref<readonly CanvasMeta[]>>;
  closeCanvasTab(id: string): Promise<void>;
  reset(): void;
  refreshDirectory(): Promise<void>;
  refreshAfterRestore(): Promise<void>;
  loadWorkspaces(target?: {
    workspaceId: string;
    canvasId: string;
  }): Promise<void>;
  /** 设置置顶而不切换编辑器；失败回读目录，无法确认时锁定目录修改。 */
  setCanvasPinned(canvas: CanvasMeta, pinned: boolean): Promise<void>;
  /** 接收置顶组在前的完整显示顺序，仅允许组内调整基础排序槽位。 */
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
  const selecting = ref(false);
  const canvases = ref<CanvasMeta[]>([]);
  const workspaceId = ref("");
  const tabs = useCanvasTabs();
  const canvasTabs = computed(() =>
    tabs.ids(workspaceId.value).flatMap((id) => {
      const canvas = canvases.value.find((entry) => entry.id === id);

      return canvas ? [canvas] : [];
    }),
  );

  type Directory = CanvasCatalog;

  const catalogRevision = ref(0);
  const directoryStale = ref(false);
  const directoryLocked = computed(
    () => interactionLocked.value || directoryStale.value || selecting.value,
  );
  const currentWorkspace = computed(() =>
    workspaces.value.find((item) => item.id === workspaceId.value),
  );
  const { navigation, refreshNavigationQuietly, recordOpened } =
    navigationController;
  const { document, loadCanvas } = canvasDocument;
  const flush = () => editor.flush();
  const checkpoint = () => (editor.checkpoint ? editor.checkpoint() : flush());
  let switchGeneration = 0;
  let requestedWorkspace = "";

  function reset() {
    switchGeneration++;
    requestedWorkspace = "";
    selecting.value = false;
    workspaces.value = [];
    canvases.value = [];
    workspaceId.value = "";
    catalogRevision.value = 0;
    directoryStale.value = false;
    tabs.reset();
  }

  async function refreshAfterRestore() {
    const generation = switchGeneration;
    const entries = await api.listWorkspaces();

    if (generation !== switchGeneration) return;
    workspaces.value = entries;
    if (
      workspaceId.value &&
      entries.some((entry) => entry.id === workspaceId.value)
    )
      await refreshDirectory();
    else if (!document.value) await loadWorkspaces();
  }

  async function readDirectory(id: string) {
    const generation = switchGeneration;
    const catalog = await api.readCatalog(id);

    for (const canvas of catalog.canvases) {
      if (generation !== switchGeneration) break;
      await canvasDocument.restoreCanvas?.(canvas.id);
    }

    return catalog;
  }

  function setDirectory(id: string, data: Directory) {
    workspaceId.value = id;
    canvases.value = data.canvases;
    catalogRevision.value = data.catalogRevision;
    directoryStale.value = false;
    tabs.reconcile(
      id,
      data.canvases.map((canvas) => canvas.id),
    );
  }

  async function refreshDirectory() {
    if (!workspaceId.value) return;
    const id = workspaceId.value;
    const generation = switchGeneration;

    try {
      const data = await readDirectory(id);

      if (generation === switchGeneration && id === workspaceId.value) {
        setDirectory(id, data);
      }
    } catch (error) {
      if (generation !== switchGeneration || id !== workspaceId.value) return;
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
    generation = ++switchGeneration,
    strictPreferred = false,
  ) {
    if (generation !== switchGeneration) return;
    const data = await readDirectory(id);

    if (generation !== switchGeneration) return;
    if (strictPreferred && !data.canvases.some((item) => item.id === preferred))
      throw new Error("目标画布不可访问");
    tabs.reconcile(
      id,
      data.canvases.map((canvas) => canvas.id),
    );
    const remembered =
      explicit && preferred
        ? preferred
        : tabs.active(id) !== undefined
          ? tabs.active(id)
          : (preferred ??
            navigation.value?.workspaces.find((item) => item.workspaceId === id)
              ?.lastCanvasId);
    const selected =
      remembered === null && tabs.active(id) === null
        ? undefined
        : (data.canvases.find((item) => item.id === remembered) ??
          data.canvases[0]);

    // Scene loading is independent of the account-level lazy library.
    if (selected) await loadCanvas(selected.id, selected);
    else {
      canvasDocument.clearDocument();
    }

    if (generation !== switchGeneration) return;
    setDirectory(id, data);
    if (selected) tabs.open(id, selected.id);
    if (selected && (explicit || !navigation.value?.lastCanvasId))
      void recordOpened(selected.id);
  }

  async function loadWorkspaces(target?: {
    workspaceId: string;
    canvasId: string;
  }) {
    const generation = ++switchGeneration;

    selecting.value = true;

    try {
      const [data] = await Promise.all([
        api.listWorkspaces(),
        refreshNavigationQuietly(),
      ]);

      if (generation !== switchGeneration) return;
      const entries = data;

      workspaces.value = entries;
      if (!entries.length) {
        reset();
        canvasDocument.clearDocument("没有工作空间");

        return;
      }

      if (target) {
        if (!entries.some((item) => item.id === target.workspaceId))
          throw new Error("目标工作空间不可访问");
        const listing = await readDirectory(target.workspaceId);

        if (generation !== switchGeneration) return;
        if (!listing.canvases.some((item) => item.id === target.canvasId))
          throw new Error("目标画布不可访问");
        await loadWorkspace(
          target.workspaceId,
          target.canvasId,
          true,
          generation,
          true,
        );

        return;
      }

      const remembered = entries.find(
        (item) => item.id === navigation.value?.lastWorkspaceId,
      );

      // A deleted/empty recent space falls back to the first nonempty space, without creating data.
      if (remembered) {
        const recentDirectory = await readDirectory(remembered.id);

        if (generation !== switchGeneration) return;

        if (recentDirectory.canvases.length) {
          await loadWorkspace(
            remembered.id,
            navigation.value?.lastCanvasId,
            false,
            generation,
          );

          return;
        }
      }

      for (const entry of entries) {
        const listing = await readDirectory(entry.id);

        if (generation !== switchGeneration) return;

        if (listing.canvases.length) {
          await loadWorkspace(
            entry.id,
            listing.canvases[0]!.id,
            false,
            generation,
          );

          return;
        }
      }

      await loadWorkspace(
        remembered?.id ?? entries[0]!.id,
        undefined,
        false,
        generation,
      );
    } catch (error) {
      if (generation !== switchGeneration) return;
      throw error;
    } finally {
      if (generation === switchGeneration) selecting.value = false;
    }
  }

  async function setCanvasPinned(canvas: CanvasMeta, pinned: boolean) {
    if (
      directoryLocked.value ||
      !canvases.value.some((entry) => entry.id === canvas.id)
    )
      return;
    const id = workspaceId.value;
    const generation = switchGeneration;
    const revision = catalogRevision.value;
    const stillCurrent = () =>
      generation === switchGeneration && id === workspaceId.value;

    await run(async () => {
      try {
        const data = await api.setCanvasPinned(canvas.id, pinned, revision);

        if (stillCurrent()) setDirectory(id, data);
      } catch (cause) {
        if (!stillCurrent()) return;
        await refreshDirectory();
        if (!stillCurrent()) return;
        const confirmed = canvases.value.find(
          (entry) => entry.id === canvas.id,
        );

        if (confirmed && !!confirmed.pinned === pinned) return;
        throw new Error(
          cause instanceof ApiError && cause.code === "CATALOG_CONFLICT"
            ? "列表已在其他页面更新，请重新设置置顶。"
            : "置顶状态未保存，已恢复服务端列表，请重试。",
          { cause },
        );
      }
    });
  }

  async function reorderCanvas(ids: string[]) {
    if (
      directoryLocked.value ||
      ids.every((id, i) => id === canvases.value[i]?.id)
    )
      return;
    const previous = [...canvases.value];

    if (
      ids.length !== previous.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !previous.some((canvas) => canvas.id === id))
    )
      return;
    const ordered = ids.map((id) =>
      previous.find((canvas) => canvas.id === id)!,
    );

    if (
      ordered.some(
        (canvas, index) => !!canvas.pinned !== !!previous[index]?.pinned,
      )
    )
      return;
    const id = workspaceId.value;
    const generation = switchGeneration;
    const revision = catalogRevision.value;
    const stillCurrent = () =>
      generation === switchGeneration && id === workspaceId.value;

    await run(async () => {
      canvases.value = ordered;
      try {
        const data = await api.reorder(id, ids, revision);

        if (stillCurrent()) setDirectory(id, data);
      } catch (cause) {
        if (!stillCurrent()) return;
        canvases.value = previous;
        // A response can be lost after commit. Always re-read instead of sending the old order again.
        await refreshDirectory();
        if (!stillCurrent()) return;
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
    if (
      interactionLocked.value ||
      (id === workspaceId.value && !requestedWorkspace)
    )
      return;
    const generation = ++switchGeneration;

    requestedWorkspace = id;
    selecting.value = true;
    try {
      await checkpoint();
      if (generation !== switchGeneration) return;
      await loadWorkspace(id, undefined, true, generation);
    } catch (error) {
      if (generation === switchGeneration)
        await run(async () => {
          throw error;
        });
    } finally {
      if (generation === switchGeneration) {
        requestedWorkspace = "";
        selecting.value = false;
      }
    }
  }

  async function selectCanvas(id: string) {
    if (
      interactionLocked.value ||
      (id === document.value?.id && !selecting.value)
    )
      return;
    const generation = ++switchGeneration;

    requestedWorkspace = "";
    selecting.value = true;
    try {
      await checkpoint();
      if (generation !== switchGeneration) return;
      await loadCanvas(
        id,
        canvases.value.find((item) => item.id === id),
      );
      if (generation === switchGeneration) {
        tabs.open(workspaceId.value, id);
        void recordOpened(id);
      }
    } catch (error) {
      if (generation === switchGeneration)
        await run(async () => {
          throw error;
        });
    } finally {
      if (generation === switchGeneration) selecting.value = false;
    }
  }

  async function closeCanvasTab(id: string) {
    if (directoryLocked.value || !tabs.ids(workspaceId.value).includes(id))
      return;
    if (id !== document.value?.id) {
      canvasDocument.releaseEditorHistory(id);
      tabs.close(workspaceId.value, id);

      return;
    }

    const generation = ++switchGeneration;

    selecting.value = true;
    try {
      // Capture and durably protect edits before removing the only mounted editor.
      // Resources remain account-owned and continue saving after the view closes.
      await checkpoint();
      if (generation !== switchGeneration) return;
      canvasDocument.releaseEditorHistory(id);
      tabs.close(workspaceId.value, id);
      const next = tabs.active(workspaceId.value);

      if (next) {
        await loadCanvas(
          next,
          canvases.value.find((canvas) => canvas.id === next),
        );
        if (generation === switchGeneration) void recordOpened(next);
      } else canvasDocument.clearDocument("没有打开的画布");
    } catch (error) {
      if (generation === switchGeneration)
        await run(async () => {
          throw error;
        });
    } finally {
      if (generation === switchGeneration) selecting.value = false;
    }
  }

  async function createWorkspace() {
    if (directoryLocked.value) return;
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
    if (directoryLocked.value) return;
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
    if (directoryLocked.value) return;
    if (
      !(await dialogs.confirm({
        title: "移入回收站",
        message: `将「${currentWorkspace.value?.name}」及其中所有画布移入回收站？30 天内可以恢复。`,
        confirmLabel: "移入回收站",
        danger: true,
      }))
    )
      return;
    await run(async () => {
      await flush();
      const deletingId = workspaceId.value;
      let failure: unknown;

      try {
        await api.deleteWorkspace(deletingId);
      } catch (cause) {
        failure = cause;
      }

      if (
        failure &&
        (await api.listWorkspaces()).some((entry) => entry.id === deletingId)
      )
        throw failure;
      for (const canvas of canvases.value)
        canvasDocument.invalidateCanvas(canvas.id);
      canvasDocument.clearDocument();
      workspaceId.value = "";
      canvases.value = [];
      await loadWorkspaces();
    });
  }

  async function createCanvas() {
    if (directoryLocked.value || !workspaceId.value) return;
    const now = new Date();
    const name = await dialogs.prompt({
      title: "新建画布",
      label: "画布名称",
      initialValue: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
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
      tabs.open(workspaceId.value, canvas.id);
      await recordOpened(canvas.id);
    });
  }

  async function renameCanvas(canvas: CanvasMeta) {
    if (directoryLocked.value) return;
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
        title: "移入回收站",
        message: `将画布「${canvas.name}」移入回收站？30 天内可以恢复。`,
        confirmLabel: "移入回收站",
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
      if (canvasDocument.invalidateCanvas(canvas.id)) {
        await refreshNavigationQuietly();
        await loadWorkspace(workspaceId.value);
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
    canvasTabs,
    closeCanvasTab,
    reset,
    refreshDirectory,
    refreshAfterRestore,
    loadWorkspaces,
    setCanvasPinned,
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
