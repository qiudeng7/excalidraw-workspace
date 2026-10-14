import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { CanvasScene } from "#shared/contracts";

export interface EditorHistory {
  snapshot: ReturnType<ExcalidrawImperativeAPI["history"]["getSnapshot"]>;
  files: ReturnType<ExcalidrawImperativeAPI["getFiles"]>;
  signature: string;
  epoch: string;
  selection: Pick<
    AppState,
    "selectedElementIds" | "selectedGroupIds" | "editingGroupId"
  >;
}

/** Ignore server revision/normalization; IDs, versions and order describe content. */
export function editorContentSignature(scene: CanvasScene) {
  return JSON.stringify([
    scene.elements.map((item) => {
      const element = item as {
        id: string;
        version?: number;
        versionNonce?: number;
        isDeleted?: boolean;
      };

      return [
        element.id,
        element.version ?? 0,
        element.versionNonce ?? 0,
        !!element.isDeleted,
      ];
    }),
    scene.appState.viewBackgroundColor ?? "#ffffff",
  ]);
}

export function captureEditorHistory(
  editor: ExcalidrawImperativeAPI,
  epoch: string,
): EditorHistory {
  const state = editor.getAppState();

  return {
    snapshot: editor.history.getSnapshot(),
    files: { ...editor.getFiles() },
    signature: editorContentSignature({
      elements: [...editor.getSceneElementsIncludingDeleted()],
      appState: { viewBackgroundColor: state.viewBackgroundColor },
      files: {},
    }),
    epoch,
    selection: {
      selectedElementIds: { ...state.selectedElementIds },
      selectedGroupIds: { ...state.selectedGroupIds },
      editingGroupId: state.editingGroupId,
    },
  };
}

export function restoreEditorHistory(
  editor: ExcalidrawImperativeAPI,
  saved: EditorHistory | undefined,
  scene: CanvasScene,
  epoch: string,
) {
  if (
    !saved ||
    saved.epoch !== epoch ||
    saved.signature !== editorContentSignature(scene)
  ) {
    editor.history.clear();

    return false;
  }

  // Deleted images are filtered from snapshots but their undo data stays in memory.
  editor.addFiles(Object.values(saved.files));
  const live = scene.elements.filter(
    (item) => !(item as { isDeleted?: boolean }).isDeleted,
  ) as { id: string; groupIds?: string[] }[];
  const liveIds = new Set(live.map((element) => element.id));
  const groups = new Set(live.flatMap((element) => element.groupIds ?? []));

  editor.updateScene({
    appState: {
      selectedElementIds: Object.fromEntries(
        Object.entries(saved.selection.selectedElementIds).filter(
          ([id, selected]) => selected && liveIds.has(id),
        ),
      ),
      selectedGroupIds: Object.fromEntries(
        Object.entries(saved.selection.selectedGroupIds).filter(
          ([id, selected]) => selected && groups.has(id),
        ),
      ),
      editingGroupId:
        saved.selection.editingGroupId &&
        groups.has(saved.selection.editingGroupId)
          ? saved.selection.editingGroupId
          : null,
    },
    captureUpdate: "NEVER",
  });
  editor.history.restoreSnapshot(saved.snapshot);

  return true;
}
