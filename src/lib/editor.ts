/** The page only coordinates save barriers; Excalidraw internals stay inside its wrapper. */
export interface EditorHandle {
  flush(): Promise<void>
  saveManually(): Promise<void>
}
export interface SaveBarrier {
  flush(): Promise<void>
}
