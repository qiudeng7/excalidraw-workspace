import type {
  CanvasCatalog,
  CanvasDocument,
  CanvasMeta,
  LibraryDocument,
  Navigation,
  Workspace,
} from "../../shared/contracts";
import {
  snapshotValidator,
  canvasValidator,
} from "../../shared/snapshotValidator";
import { api, conditionalApi } from "./api";

/** HTTP details belong here; controllers depend on this replaceable domain port. */
export interface WorkspaceApi {
  listWorkspaces(): Promise<Workspace[]>;
  readCatalog(workspaceId: string): Promise<CanvasCatalog>;
  readCanvas(canvasId: string): Promise<CanvasDocument>;
  readLibrary(ownerId: string): Promise<LibraryDocument>;
  validateCanvas?(
    id: string,
    ownerId: string,
    known?: CanvasDocument,
    signal?: AbortSignal,
  ): Promise<CanvasDocument | undefined>;
  validateLibrary?(
    ownerId: string,
    known?: LibraryDocument,
    signal?: AbortSignal,
  ): Promise<LibraryDocument | undefined>;
  readNavigation(ownerId?: string): Promise<Navigation>;
  recordOpened(
    canvasId: string,
    revision: number,
    ownerId?: string,
  ): Promise<Navigation>;
  reorder(
    workspaceId: string,
    canvasIds: string[],
    catalogRevision: number,
  ): Promise<CanvasCatalog>;
  createWorkspace(name: string): Promise<Workspace>;
  renameWorkspace(id: string, name: string): Promise<Workspace>;
  deleteWorkspace(id: string): Promise<void>;
  createCanvas(
    workspaceId: string,
    name: string,
    catalogRevision: number,
  ): Promise<CanvasMeta>;
  renameCanvas(id: string, name: string): Promise<CanvasMeta>;
  deleteCanvas(id: string, catalogRevision: number): Promise<void>;
}
const segment = encodeURIComponent;
const json = (method: string, payload: unknown): RequestInit => ({
  method,
  body: JSON.stringify(payload),
});

export const workspaceApi: WorkspaceApi = {
  listWorkspaces: async () =>
    (await api<{ workspaces: Workspace[] }>("/api/workspaces")).workspaces,
  readCatalog: (id) =>
    api<CanvasCatalog>(`/api/workspaces/${segment(id)}/canvases`),
  readCanvas: async (id) =>
    (await api<{ canvas: CanvasDocument }>(`/api/canvases/${segment(id)}`))
      .canvas,
  readLibrary: (ownerId) =>
    api<LibraryDocument>("/api/library", {
      headers: { "X-Resource-Owner": ownerId },
    }),
  validateCanvas: async (id, ownerId, known, signal) => {
    const response = await conditionalApi<{ canvas: CanvasDocument }>(
      `/api/canvases/${segment(id)}`,
      {
        signal,
        headers: {
          "X-Resource-Owner": ownerId,
          ...(known
            ? {
                "If-None-Match": canvasValidator(known),
              }
            : {}),
        },
      },
    );

    return response?.canvas;
  },
  validateLibrary: (ownerId, known, signal) =>
    conditionalApi<LibraryDocument>("/api/library", {
      signal,
      headers: {
        "X-Resource-Owner": ownerId,
        ...(known
          ? {
              "If-None-Match": snapshotValidator(
                "library",
                ownerId,
                known.revision,
              ),
            }
          : {}),
      },
    }),
  readNavigation: (ownerId) =>
    api<Navigation>("/api/navigation", {
      headers: ownerId ? { "X-Resource-Owner": ownerId } : {},
    }),
  recordOpened: (canvasId, revision, ownerId) =>
    api<Navigation>("/api/navigation", {
      ...json("PUT", { canvasId, revision }),
      headers: ownerId ? { "X-Resource-Owner": ownerId } : {},
    }),
  reorder: (id, canvasIds, catalogRevision) =>
    api<CanvasCatalog>(
      `/api/workspaces/${segment(id)}/canvas-order`,
      json("PUT", { canvasIds, catalogRevision }),
    ),
  createWorkspace: async (name) =>
    (
      await api<{ workspace: Workspace }>(
        "/api/workspaces",
        json("POST", { name }),
      )
    ).workspace,
  renameWorkspace: async (id, name) =>
    (
      await api<{ workspace: Workspace }>(
        `/api/workspaces/${segment(id)}`,
        json("PATCH", { name }),
      )
    ).workspace,
  deleteWorkspace: async (id) => {
    await api(`/api/workspaces/${segment(id)}`, { method: "DELETE" });
  },
  createCanvas: async (id, name, catalogRevision) =>
    (
      await api<{ canvas: CanvasMeta }>(
        `/api/workspaces/${segment(id)}/canvases`,
        json("POST", { name, catalogRevision }),
      )
    ).canvas,
  renameCanvas: async (id, name) =>
    (
      await api<{ canvas: CanvasMeta }>(
        `/api/canvases/${segment(id)}`,
        json("PATCH", { name }),
      )
    ).canvas,
  deleteCanvas: async (id, catalogRevision) => {
    await api(
      `/api/canvases/${segment(id)}`,
      json("DELETE", { catalogRevision }),
    );
  },
};
