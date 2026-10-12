/** The page only coordinates save barriers; Excalidraw internals stay inside its wrapper. */
export interface EditorHandle {
  capture(): void;
  checkpoint?(): Promise<void>;
  refresh?(): Promise<void>;
  flush(): Promise<void>;
  saveManually(): Promise<void>;
}

export interface SaveBarrier {
  checkpoint?(): Promise<void>;
  flush(): Promise<void>;
}
