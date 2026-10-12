import { shallowReadonly, shallowRef, ref, triggerRef, type Ref } from "vue";
import type {
  CanvasDocument,
  CanvasMeta,
  LibraryDocument,
} from "../../shared/contracts";
import type { WorkspaceApi } from "../lib/workspaceApi";
import { CanvasResources, type CanvasResource } from "../lib/canvasResources";
import { ApiError } from "../lib/api";

export interface CanvasDocumentController {
  document: Readonly<Ref<CanvasDocument | undefined>>;
  library: Readonly<Ref<LibraryDocument | undefined>>;
  current: Readonly<Ref<CanvasResource | undefined>>;
  resources: Readonly<Ref<CanvasResources | undefined>>;
  saveState: Readonly<Ref<string>>;
  loadingCanvas: Readonly<Ref<boolean>>;
  loadCanvas(id: string, metadata?: CanvasMeta): Promise<void>;
  checkpoint(): Promise<void>;
  flushAll(): Promise<void>;
  ensureLibrary(): Promise<void>;
  renameLoadedCanvas(id: string, name: string): void;
  clearDocument(message?: string): void;
  invalidateCanvas(id: string): boolean;
  reset(): void;
  setSaveState(message: string): void;
}

export interface CanvasDocumentDependencies {
  api: Pick<
    WorkspaceApi,
    "readCanvas" | "readLibrary" | "validateCanvas" | "validateLibrary"
  >;
  ownerId(): string;
  onLoaded(): void;
}

export function useCanvasDocument({
  api,
  ownerId,
  onLoaded,
}: CanvasDocumentDependencies): CanvasDocumentController {
  const document = shallowRef<CanvasDocument>();
  const library = shallowRef<LibraryDocument>();
  const current = shallowRef<CanvasResource>();
  const resources = shallowRef<CanvasResources>();
  const saveState = ref("正在加载");
  const loadingCanvas = ref(false);
  let selection = 0;
  let selectedId = "";

  function publish() {
    const entry = current.value;
    const manager = resources.value;

    if (entry) {
      document.value = { ...entry.document, scene: entry.resource.value };
      saveState.value =
        entry.status === "checking"
          ? "正在校验版本…"
          : entry.status === "error"
            ? "校验失败 · 只读"
            : entry.resource.conflict || manager?.library?.conflict
              ? "保存冲突"
              : entry.message || manager?.libraryMessage
                ? "保存异常"
                : entry.resource.isSaving || manager?.library?.isSaving
                  ? "正在保存…"
                  : entry.resource.dirty || manager?.library?.dirty
                    ? "待保存…"
                    : "已保存";
      triggerRef(current);
    }

    library.value = manager?.library
      ? { items: manager.library.value, revision: manager.library.revision }
      : undefined;
    triggerRef(resources);
  }

  function manager() {
    const owner = ownerId();

    if (resources.value?.owner !== owner) {
      resources.value?.dispose();
      current.value = undefined;
      resources.value = new CanvasResources(owner, api, publish);
    }

    return resources.value!;
  }

  async function loadCanvas(id: string, metadata?: CanvasMeta) {
    const generation = ++selection;

    selectedId = id;

    loadingCanvas.value = true;
    const store = manager();
    let displayed = false;
    const preview = (entry: CanvasResource) => {
      if (generation !== selection || resources.value !== store) return;
      current.value = entry;
      store.setActive(id);
      publish();
      if (!displayed) {
        displayed = true;
        onLoaded();
      }
    };

    // Do not retain another canvas as an apparently editable destination during a cold load.
    current.value = undefined;
    document.value = undefined;
    saveState.value = "正在加载";
    try {
      await store.open(id, preview, metadata);
    } catch (error) {
      if (generation !== selection || resources.value !== store) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status))
        clearDocument(error.message);
      throw error;
    } finally {
      if (generation === selection) loadingCanvas.value = false;
    }
  }

  function clearDocument(message = "没有画布") {
    selection++;
    selectedId = "";
    loadingCanvas.value = false;
    current.value = undefined;
    document.value = undefined;
    saveState.value = message;
  }

  return {
    document: shallowReadonly(document),
    library: shallowReadonly(library),
    current: shallowReadonly(current),
    resources: shallowReadonly(resources),
    saveState: shallowReadonly(saveState),
    loadingCanvas: shallowReadonly(loadingCanvas),
    loadCanvas,
    clearDocument,
    invalidateCanvas(id) {
      const selected = selectedId === id || current.value?.document.id === id;

      if (selected) clearDocument();
      void resources.value?.invalidate(id);

      return selected;
    },
    checkpoint: async () => {
      if (current.value)
        await resources.value?.checkpoint(current.value.document.id);
    },
    flushAll: async () => {
      await resources.value?.flushAll();
    },
    ensureLibrary: async () => {
      await manager().ensureLibrary();
    },
    renameLoadedCanvas(id, name) {
      const entry = resources.value?.canvases.get(id);

      if (entry) {
        entry.metadataGeneration++;
        entry.document = { ...entry.document, name };
      }

      publish();
    },
    setSaveState(message) {
      saveState.value = message;
    },
    reset() {
      clearDocument();
      resources.value?.dispose();
      resources.value = undefined;
      library.value = undefined;
    },
  };
}
