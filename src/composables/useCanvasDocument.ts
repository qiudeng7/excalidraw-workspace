import { shallowReadonly, shallowRef, ref, type Ref } from "vue";
import type { CanvasDocument, LibraryDocument } from "../../shared/contracts";
import type { WorkspaceApi } from "../lib/workspaceApi";

export interface CanvasDocumentController {
  document: Readonly<Ref<CanvasDocument | undefined>>;
  library: Readonly<Ref<LibraryDocument | undefined>>;
  saveState: Readonly<Ref<string>>;
  loadCanvas(id: string): Promise<void>;
  renameLoadedCanvas(id: string, name: string): void;
  clearDocument(message?: string): void;
  reset(): void;
  setSaveState(message: string): void;
}

export interface CanvasDocumentDependencies {
  api: Pick<WorkspaceApi, "readCanvas" | "readLibrary">;
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
  const saveState = ref("正在加载");

  async function loadCanvas(id: string) {
    // Keep the previous editor until BOTH reads succeed, and capture the account before dispatch.
    const [canvas, items] = await Promise.all([
      api.readCanvas(id),
      api.readLibrary(ownerId()),
    ]);

    library.value = items;
    document.value = canvas;
    saveState.value = "已保存";
    onLoaded();
  }

  function clearDocument(message = "没有画布") {
    document.value = undefined;
    saveState.value = message;
  }

  return {
    document: shallowReadonly(document),
    library: shallowReadonly(library),
    saveState: shallowReadonly(saveState),
    loadCanvas,
    clearDocument,
    renameLoadedCanvas(id, name) {
      if (document.value?.id === id)
        document.value = { ...document.value, name };
    },
    setSaveState(message) {
      saveState.value = message;
    },
    reset() {
      clearDocument();
      library.value = undefined;
    },
  };
}
