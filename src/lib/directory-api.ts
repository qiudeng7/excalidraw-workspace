import type { CanvasMeta } from "#shared/contracts";
import type {
  BatchDirectoryRequest,
  BatchDirectorySummaryResponse,
  BatchMoveDirectoryRequest,
  BatchMoveDirectoryResponse,
  BatchDeleteDirectoryResponse,
  BatchUndoDirectoryRequest,
  BatchUndoDirectoryResponse,
  DirectoryNode,
  DirectoryPage,
  DirectoryPath,
  MoveDirectoryRequest,
  NodeRef,
} from "#shared/directory-contracts";
import { api } from "~/lib/api";

/** 所有者目录；组织和收藏共用目录版本，不参与画布内容保存。 */
export interface DirectoryApi {
  children(
    workspace: string,
    parentId: string | null,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<DirectoryPage>;
  path(
    workspace: string,
    source: NodeRef,
    signal?: AbortSignal,
  ): Promise<DirectoryPath>;
  favorites(
    workspace: string,
    signal?: AbortSignal,
  ): Promise<{ items: DirectoryNode[]; catalogRevision: number }>;
  create(
    workspace: string,
    kind: NodeRef["kind"],
    name: string,
    parentId: string | null,
    catalogRevision: number,
  ): Promise<DirectoryNode | CanvasMeta>;
  rename(
    item: DirectoryNode,
    name: string,
    catalogRevision: number,
  ): Promise<void>;
  move(workspace: string, input: DirectoryMove): Promise<void>;
  favorite(
    workspace: string,
    source: NodeRef,
    favorite: boolean,
    catalogRevision: number,
  ): Promise<void>;
  orderFavorite(
    workspace: string,
    source: NodeRef,
    target: NodeRef,
    placement: "before" | "after",
    catalogRevision: number,
  ): Promise<void>;
  summary(id: string): Promise<{
    folderCount: number;
    canvasCount: number;
    catalogRevision: number;
  }>;
  remove(
    item: DirectoryNode,
    catalogRevision: number,
  ): Promise<{ affectedCanvasIds: string[]; affectedFolderIds?: string[] }>;
  restore(source: NodeRef, parentId?: string | null): Promise<void>;
  batchSummary(
    workspace: string,
    input: BatchDirectoryRequest,
  ): Promise<BatchDirectorySummaryResponse>;
  batchMove(
    workspace: string,
    input: BatchMoveDirectoryRequest,
  ): Promise<BatchMoveDirectoryResponse>;
  batchDelete(
    workspace: string,
    input: BatchDirectoryRequest,
  ): Promise<BatchDeleteDirectoryResponse>;
  batchUndo(
    workspace: string,
    input: BatchUndoDirectoryRequest,
  ): Promise<BatchUndoDirectoryResponse>;
}

export type DirectoryMove = MoveDirectoryRequest;

export const nodeKey = (item: NodeRef) => `${item.kind}:${item.id}`;
const reference = ({ kind, id }: NodeRef): NodeRef => ({ kind, id });
const segment = encodeURIComponent;
const base = (workspace: string) => `/api/workspaces/${segment(workspace)}`;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export const directoryApi: DirectoryApi = {
  batchSummary: (workspace, input) =>
    api(`${base(workspace)}/directory/batch/summary`, json("POST", input)),
  batchMove: (workspace, input) =>
    api(`${base(workspace)}/directory/batch/move`, json("PUT", input)),
  batchDelete: (workspace, input) =>
    api(`${base(workspace)}/directory/batch/delete`, json("POST", input)),
  batchUndo: (workspace, input) =>
    api(`${base(workspace)}/directory/batch/undo`, json("POST", input)),
  children(workspace, parentId, cursor, signal) {
    const query = new URLSearchParams({ limit: "30" });

    if (parentId) query.set("parentId", parentId);
    if (cursor) query.set("cursor", cursor);

    return api(`${base(workspace)}/directory?${query}`, { signal });
  },
  path: (workspace, source, signal) =>
    api(
      `${base(workspace)}/directory/path?${new URLSearchParams({ kind: source.kind, id: source.id })}`,
      { signal },
    ),
  favorites: (workspace, signal) =>
    api(`${base(workspace)}/favorites`, { signal }),
  async create(workspace, kind, name, parentId, catalogRevision) {
    if (kind === "folder") {
      return (
        await api<{ item: DirectoryNode }>(
          `${base(workspace)}/folders`,
          json("POST", { name, parentId, catalogRevision }),
        )
      ).item;
    }

    return (
      await api<{ canvas: CanvasMeta }>(
        `${base(workspace)}/canvases`,
        json("POST", { name, parentId, catalogRevision }),
      )
    ).canvas;
  },
  async rename(item, name, catalogRevision) {
    await api(
      `/api/${item.kind === "folder" ? "folders" : "canvases"}/${segment(item.id)}`,
      json("PATCH", { name, catalogRevision }),
    );
  },
  async move(workspace, input) {
    await api(
      `${base(workspace)}/directory/move`,
      json("PUT", {
        ...input,
        source: reference(input.source),
        target: input.target ? reference(input.target) : undefined,
      }),
    );
  },
  async favorite(workspace, source, favorite, catalogRevision) {
    await api(
      `${base(workspace)}/favorites`,
      json("PUT", { source: reference(source), favorite, catalogRevision }),
    );
  },
  async orderFavorite(workspace, source, target, placement, catalogRevision) {
    await api(
      `${base(workspace)}/favorites/order`,
      json("PUT", {
        source: reference(source),
        target: reference(target),
        placement,
        catalogRevision,
      }),
    );
  },
  summary: (id) => api(`/api/folders/${segment(id)}/summary`),
  async remove(item, catalogRevision) {
    if (item.kind === "folder") {
      return api(
        `/api/folders/${segment(item.id)}`,
        json("DELETE", { catalogRevision }),
      );
    }

    await api(
      `/api/canvases/${segment(item.id)}`,
      json("DELETE", { catalogRevision }),
    );

    return { affectedCanvasIds: [item.id] };
  },
  async restore(source, parentId) {
    await api(
      `/api/recycle-bin/${source.kind}/${segment(source.id)}`,
      json("POST", parentId === undefined ? {} : { parentId }),
    );
  },
};
