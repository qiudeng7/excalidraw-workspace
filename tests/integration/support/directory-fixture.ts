// 真实 H3 路由、迁移和临时 SQLite；只建立账号与目录数据，不替换目录实现。
// 目录、收藏、移动和路径定位都走公开 HTTP，供侧栏文件夹集成测试复用。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeStorage } from "./storage";
import { handleApi } from "./api";
import type {
  DirectoryNode,
  DirectoryPage,
  DirectoryPath,
  DirectoryRecycleEntry,
  FolderRecycleEntry,
  FolderSummary,
  MoveDirectoryRequest,
  NodeRef,
  RestoreCanvasResponse,
  RestoreFolderResponse,
} from "#shared/directory-contracts";
import type {
  CanvasCatalog,
  CanvasMeta,
  RecycleEntry,
} from "#shared/contracts";

export interface DirectoryRequestResult {
  status: number;
  body: any;
  cookie: string;
}

const origin = "https://directory.test";

export const directoryFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "sidebar-directory-"));
  const storage = await nodeStorage(directory);
  const pending: Promise<unknown>[] = [];
  let ownerCookie = "";
  let memberCookie = "";
  const request = async (
    path: string,
    method = "GET",
    data?: unknown,
    cookie = ownerCookie,
  ): Promise<DirectoryRequestResult> => {
    const response = await handleApi(
      new Request(`${origin}/api${path}`, {
        method,
        headers: {
          Origin: origin,
          "X-Requested-With": "excalidraw-demo",
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      {
        ...storage,
        publicOrigin: origin,
        waitUntil: (task) => pending.push(task),
      },
    );
    const text = await response.text();

    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    };
  };
  const expectStatus = (result: DirectoryRequestResult, status: number) => {
    assert.equal(result.status, status, JSON.stringify(result.body));

    return result;
  };
  const owner = expectStatus(
    await request("/setup", "POST", {
      email: "directory-owner@example.test",
      password: "DirectoryPassword123!",
    }),
    200,
  );

  ownerCookie = owner.cookie;
  const member = expectStatus(
    await request(
      "/register",
      "POST",
      {
        email: "directory-member@example.test",
        password: "DirectoryPassword123!",
      },
      "",
    ),
    200,
  );

  memberCookie = member.cookie;
  const spaces = expectStatus(await request("/workspaces"), 200).body
    .workspaces as { id: string; catalogRevision: number }[];
  const workspaceId = spaces[0]!.id;
  const accountSpaces = (cookie: string) =>
    request("/workspaces", "GET", undefined, cookie);
  let revision = 0;
  const currentRevision = async () => {
    if (!revision) {
      const page = await request(`/workspaces/${workspaceId}/directory`);

      expectStatus(page, 200);
      revision = page.body.catalogRevision;
    }

    return revision;
  };
  const track = (result: DirectoryRequestResult) => {
    if (typeof result.body?.catalogRevision === "number")
      revision = result.body.catalogRevision;

    return result;
  };
  const page = async (
    parentId?: string | null,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<DirectoryPage> => {
    const query = new URLSearchParams();

    if (parentId) query.set("parentId", parentId);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);

    const suffix = query.size ? `?${query}` : "";

    return expectStatus(
      await request(`/workspaces/${workspaceId}/directory${suffix}`),
      200,
    ).body as DirectoryPage;
  };
  const path = async (node: NodeRef): Promise<DirectoryPath> => {
    const query = new URLSearchParams({ kind: node.kind, id: node.id });

    return expectStatus(
      await request(`/workspaces/${workspaceId}/directory/path?${query}`),
      200,
    ).body as DirectoryPath;
  };
  const catalog = async (): Promise<CanvasCatalog> =>
    expectStatus(await request(`/workspaces/${workspaceId}/canvases`), 200)
      .body as CanvasCatalog;
  const createFolder = async (
    name: string,
    parentId: string | null = null,
  ): Promise<Extract<DirectoryNode, { kind: "folder" }>> => {
    const result = track(
      await request(`/workspaces/${workspaceId}/folders`, "POST", {
        name,
        parentId,
        catalogRevision: await currentRevision(),
      }),
    );

    expectStatus(result, 200);

    return result.body.item;
  };
  const createCanvas = async (
    name: string,
    parentId: string | null = null,
  ): Promise<CanvasMeta> => {
    const result = track(
      await request(`/workspaces/${workspaceId}/canvases`, "POST", {
        name,
        parentId,
        catalogRevision: await currentRevision(),
      }),
    );

    expectStatus(result, 200);

    return result.body.canvas;
  };
  const renameFolder = async (id: string, name: string) =>
    track(
      await request(`/folders/${id}`, "PATCH", {
        name,
        catalogRevision: await currentRevision(),
      }),
    );
  const move = async (body: Omit<MoveDirectoryRequest, "catalogRevision">) =>
    track(
      await request(`/workspaces/${workspaceId}/directory/move`, "PUT", {
        ...body,
        catalogRevision: await currentRevision(),
      }),
    );
  const favorites = async () => {
    const result = expectStatus(
      await request(`/workspaces/${workspaceId}/favorites`),
      200,
    );

    revision = result.body.catalogRevision;

    return result.body.items as DirectoryNode[];
  };
  const favorite = async (source: NodeRef, value = true) =>
    track(
      await request(`/workspaces/${workspaceId}/favorites`, "PUT", {
        source,
        favorite: value,
        catalogRevision: await currentRevision(),
      }),
    );
  const reorderFavorites = async (
    source: NodeRef,
    target: NodeRef,
    placement: "before" | "after",
  ) =>
    track(
      await request(`/workspaces/${workspaceId}/favorites/order`, "PUT", {
        source,
        target,
        placement,
        catalogRevision: await currentRevision(),
      }),
    );
  const folderSummary = async (id: string): Promise<FolderSummary> =>
    expectStatus(await request(`/folders/${id}/summary`), 200)
      .body as FolderSummary;
  const deleteFolder = async (id: string) =>
    track(
      await request(`/folders/${id}`, "DELETE", {
        catalogRevision: await currentRevision(),
      }),
    );
  const readCanvas = async (id: string) => request(`/canvases/${id}`, "GET");
  const deleteCanvas = async (id: string) =>
    track(
      await request(`/canvases/${id}`, "DELETE", {
        catalogRevision: await currentRevision(),
      }),
    );
  const recycleBin = async (cookie = ownerCookie) =>
    expectStatus(await request("/recycle-bin", "GET", undefined, cookie), 200)
      .body.entries as DirectoryRecycleEntry[];
  const restoreFolder = async (
    id: string,
    parentId?: string | null,
    cookie = ownerCookie,
  ) => {
    const result = track(
      await request(`/recycle-bin/folder/${id}`, "POST", { parentId }, cookie),
    );

    return result;
  };
  const restoreCanvas = async (
    id: string,
    parentId?: string | null,
    cookie = ownerCookie,
  ) => {
    const result = track(
      await request(`/recycle-bin/canvas/${id}`, "POST", { parentId }, cookie),
    );

    return result;
  };
  const purgeFolder = async (id: string, cookie = ownerCookie) =>
    request(`/recycle-bin/folder/${id}`, "DELETE", { confirm: true }, cookie);

  return {
    request,
    storage,
    directory,
    workspaceId,
    ownerCookie: () => ownerCookie,
    memberCookie: () => memberCookie,
    memberSpaces: () => accountSpaces(memberCookie),
    expectStatus,
    currentRevision,
    refreshRevision: async () => {
      revision = 0;

      return currentRevision();
    },
    page,
    path,
    catalog,
    createFolder,
    createCanvas,
    renameFolder,
    move,
    favorites,
    favorite,
    reorderFavorites,
    folderSummary,
    deleteFolder,
    readCanvas,
    deleteCanvas,
    recycleBin,
    restoreFolder,
    restoreCanvas,
    purgeFolder,
    async close() {
      await Promise.all(pending);
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

export const folderEntry = (
  entries: DirectoryRecycleEntry[],
  id: string,
): FolderRecycleEntry => {
  const entry = entries.find(
    (candidate) => candidate.kind === "folder" && candidate.id === id,
  );

  assert.ok(entry, `应存在文件夹回收项 ${id}`);

  return entry as FolderRecycleEntry;
};

export const canvasEntry = (
  entries: DirectoryRecycleEntry[],
  id: string,
): RecycleEntry => {
  const entry = entries.find(
    (candidate) => candidate.kind === "canvas" && candidate.id === id,
  );

  assert.ok(entry, `应存在画布回收项 ${id}`);

  return entry as RecycleEntry;
};

export const errorCode = (result: DirectoryRequestResult) =>
  result.body?.error?.code as string | undefined;

export const restoreFolderBody = (result: DirectoryRequestResult) =>
  result.body as RestoreFolderResponse;

export const restoreCanvasBody = (result: DirectoryRequestResult) =>
  result.body as RestoreCanvasResponse;
