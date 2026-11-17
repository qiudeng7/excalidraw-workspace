import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export interface EditorSearchScene {
  canvasId: string;
  elements: readonly ExcalidrawElement[];
}

/** The page coordinates saves and navigation; editor internals stay in its wrapper. */
export interface EditorHandle {
  capture(): void;
  prepareHandoff?(): Promise<void>;
  checkpoint?(): Promise<void>;
  refresh?(): Promise<void>;
  flush(): Promise<void>;
  saveManually(): Promise<void>;
  readSearchScene(): EditorSearchScene | undefined;
  locateElement(id: string): boolean;
}

export interface SaveBarrier {
  checkpoint?(): Promise<void>;
  flush(): Promise<void>;
}
