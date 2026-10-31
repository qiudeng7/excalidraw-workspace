import type { CanvasMeta, RecycleEntry } from "#shared/contracts";

/** One directory identity; kind prevents folder and canvas IDs being conflated. */
export interface NodeRef {
  kind: "folder" | "canvas";
  id: string;
}

interface DirectoryNodeBase {
  kind: NodeRef["kind"];
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  favorite: boolean;
}

export interface DirectoryFolderNode extends DirectoryNodeBase {
  kind: "folder";
  depth: number;
  childCount: number;
  /** Folder depth including itself, for validating subtree moves against the five-level limit. */
  subtreeDepth: number;
}

export interface DirectoryCanvasNode extends DirectoryNodeBase {
  kind: "canvas";
  canvas: CanvasMeta;
}

export type DirectoryNode = DirectoryFolderNode | DirectoryCanvasNode;

/** Cursor is scoped to workspace, parent directory and catalog revision. */
export interface DirectoryPage {
  parentId: string | null;
  items: DirectoryNode[];
  total: number;
  nextCursor: string | null;
  catalogRevision: number;
  /** True when a path lookup returned a window that omits earlier siblings. */
  hasPrevious?: boolean;
}

export interface DirectoryPath {
  ancestors: DirectoryNode[];
  item: DirectoryNode;
  catalogRevision: number;
  /** Root-to-target-parent pages, each starting at the next path node. */
  pages: DirectoryPage[];
}

export interface CreateFolderRequest {
  name: string;
  parentId: string | null;
  catalogRevision: number;
}

export interface CreateFolderResponse {
  item: DirectoryFolderNode;
  catalogRevision: number;
}

export interface MoveDirectoryRequest {
  source: NodeRef;
  parentId: string | null;
  target?: NodeRef;
  placement: "before" | "after" | "end";
  catalogRevision: number;
}

export interface MoveDirectoryResponse {
  catalogRevision: number;
}

export interface SetFavoriteRequest {
  source: NodeRef;
  favorite: boolean;
  catalogRevision: number;
}

export interface SetFavoriteResponse {
  item: DirectoryNode;
  catalogRevision: number;
}

export interface ReorderFavoriteRequest {
  source: NodeRef;
  target: NodeRef;
  placement: "before" | "after";
  catalogRevision: number;
}

export interface ReorderFavoriteResponse {
  catalogRevision: number;
}

export interface FolderSummary {
  folderCount: number;
  canvasCount: number;
  catalogRevision: number;
}

export interface DeleteFolderResponse {
  catalogRevision: number;
  /** Canvases newly recycled by this batch, for closing open editors/cache. */
  affectedCanvasIds: string[];
  /** Folders newly recycled by this batch, excluding previously recycled nodes. */
  affectedFolderIds: string[];
}

/** Existing canvas/workspace entries retain their legacy shape and behavior. */
export interface FolderRecycleEntry extends Omit<RecycleEntry, "kind"> {
  kind: "folder";
  workspaceId: string;
  workspaceName: string;
  parentId: string | null;
  deleteBatchId: string;
  /** Maximum folder depth in this deletion batch's subtree, including this folder. */
  subtreeDepth: number;
}

export type DirectoryRecycleEntry = RecycleEntry | FolderRecycleEntry;

export interface RecycleBinResponse {
  entries: DirectoryRecycleEntry[];
}

/** Omitted parentId restores the original parent; null explicitly targets root. */
export interface RestoreDirectoryRequest {
  /** Omitted means the original parent; null explicitly targets the root. */
  parentId?: string | null;
}

export type RestoreFolderRequest = RestoreDirectoryRequest;

export interface RestoreFolderResponse {
  catalogRevision: number;
  restoredFolderIds: string[];
  restoredCanvasIds: string[];
}

export interface RestoreCanvasResponse {
  catalogRevision: number;
  canvasId: string;
  parentId: string | null;
}

/** Existing permanent-delete route continues to require { confirm: true }. */
export interface PurgeFolderRequest {
  confirm: true;
}

export type PurgeFolderResponse = Record<never, never>;

export interface BatchDirectoryRequest {
  sources: NodeRef[];
  catalogRevision: number;
}

export type BatchDirectorySummaryRequest = BatchDirectoryRequest;

export interface BatchDirectorySummaryResponse {
  normalizedSources: NodeRef[];
  folderCount: number;
  canvasCount: number;
  catalogRevision: number;
}

export interface BatchMoveDirectoryRequest extends BatchDirectoryRequest {
  parentId: string | null;
  target?: NodeRef;
  placement: "before" | "after" | "end";
}

export interface MoveOrigin {
  source: NodeRef;
  parentId: string | null;
  /** Zero-based ordinal in the original mixed folder/canvas sibling order. */
  index: number;
}

export interface MoveDirectoryUndoReceipt {
  kind: "move";
  expectedCatalogRevision: number;
  destinationParentId: string | null;
  origins: MoveOrigin[];
}

export interface BatchMoveDirectoryResponse {
  changed: boolean;
  catalogRevision: number;
  normalizedSources: NodeRef[];
  undo: MoveDirectoryUndoReceipt | null;
}

export type BatchDeleteDirectoryRequest = BatchDirectoryRequest;

export interface DeleteRootReceipt {
  root: NodeRef;
  /** Folder roots have a batch ID; standalone canvas roots retain legacy null semantics. */
  deleteBatchId: string | null;
}

export interface DeleteDirectoryUndoReceipt {
  kind: "delete";
  expectedCatalogRevision: number;
  roots: DeleteRootReceipt[];
}

export interface BatchDeleteDirectoryResponse {
  catalogRevision: number;
  normalizedSources: NodeRef[];
  receipt: DeleteDirectoryUndoReceipt;
  affectedFolderIds: string[];
  affectedCanvasIds: string[];
}

export interface BatchUndoDirectoryRequest {
  receipt: MoveDirectoryUndoReceipt | DeleteDirectoryUndoReceipt;
}

export type BatchUndoDirectoryResponse =
  | { kind: "move"; catalogRevision: number }
  | {
      kind: "delete";
      catalogRevision: number;
      restoredFolderIds: string[];
      restoredCanvasIds: string[];
    };
