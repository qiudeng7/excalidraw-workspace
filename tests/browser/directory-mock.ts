// 侧栏目录浏览器套件共用的有状态 HTTP 替身：真实界面、分页、收藏与移动请求均由本文件响应。
// 不证明数据库、权限或真实保存；需要真实后端的断言留在 integration 套件。
import type { Page } from "@playwright/test";
import type { CanvasDocument, User } from "../../shared/contracts";
import type { WorkspaceFixture } from "./fixtures";

export type MockNode = {
  kind: "folder" | "canvas";
  workspaceId?: string;
  id: string;
  name: string;
  parentId: string | null;
  favorite?: boolean;
  position?: number;
  canvas?: CanvasDocument;
  createdAt?: string;
  updatedAt?: string;
};

export interface DirectoryMockOptions {
  nodes?: MockNode[];
  count?: number;
  recent?: string | null;
  shared?: number;
  spaces?: { id: string; name: string }[];
}

export interface DirectoryRead {
  space: string;
  parentId: string | null;
  limit: string | null;
  cursor: string | null;
}

export const installDirectoryMock = async (
  page: Page,
  workspace: WorkspaceFixture,
  options: DirectoryMockOptions = {},
) => {
  const now = "2026-10-22";
  const spaces = options.spaces ?? [
    { id: "test-space", name: "测试空间" },
    { id: "second-space", name: "第二空间" },
  ];
  const nodes: MockNode[] = options.nodes
    ? structuredClone(options.nodes)
    : Array.from({ length: options.count ?? 0 }, (_, index) => ({
        kind: "canvas" as const,
        id: `canvas-${index}`,
        name: `分页画布 ${index + 1}`,
        parentId: null,
        position: index,
      }));
  const canvasDoc = (node: MockNode): CanvasDocument => {
    node.canvas ??= {
      id: node.id,
      workspaceId: node.workspaceId ?? "test-space",
      name: node.name,
      revision: 0,
      position: node.position ?? 0,
      pinned: false,
      createdAt: now,
      updatedAt: now,
      scene: { elements: [], appState: {}, files: {} },
    };

    return node.canvas;
  };
  const favorites: string[] = nodes
    .filter((node) => node.favorite)
    .map((node) => `${node.kind}:${node.id}`);

  for (const node of nodes) canvasDoc(node);
  let revision = 0;
  let conflicts = 0;
  let user: User = { ...workspace.mock.user };
  let failNextAppend = false;
  let failFavorite = false;
  let failNextMove = false;
  let failNextRename = false;
  let appendGate: Promise<void> | undefined;
  let releaseAppend: (() => void) | undefined;
  let saveGate: Promise<void> | undefined;
  let releaseSave: (() => void) | undefined;
  let logoutCalls = 0;
  const reads: DirectoryRead[] = [];
  const pathReads: { kind: string | null; id: string | null }[] = [];
  const opened: string[] = [];
  const moves: { id: string; body: any }[] = [];
  const favoritesWrites: unknown[] = [];
  const renames: { id: string; name: string }[] = [];
  const saving: string[] = [];
  const nodeKey = (node: { kind: string; id: string }) =>
    `${node.kind}:${node.id}`;
  const find = (id: string) => nodes.find((node) => node.id === id);
  const children = (parentId: string | null, space = "test-space") =>
    nodes
      .filter(
        (node) =>
          node.parentId === parentId &&
          (node.workspaceId ?? "test-space") === space,
      )
      .sort(
        (a, b) =>
          (a.position ?? 0) - (b.position ?? 0) ||
          a.id.localeCompare(b.id) ||
          a.kind.localeCompare(b.kind),
      )
      .map((node, index) => {
        node.position = index;

        return node;
      });
  const serialize = (node: MockNode) => ({
    kind: node.kind,
    id: node.id,
    workspaceId: "test-space",
    parentId: node.parentId,
    name: node.name,
    position: node.position ?? 0,
    createdAt: node.createdAt ?? now,
    updatedAt: node.updatedAt ?? now,
    favorite: favorites.includes(nodeKey(node)),
    ...(node.kind === "folder"
      ? {
          depth: depth(node),
          childCount: children(node.id).length,
          subtreeDepth: subtreeDepth(node),
        }
      : { canvas: canvasDoc(node) }),
  });
  const depth = (node: MockNode): number => {
    let value = 1;
    let parent = node.parentId ? find(node.parentId) : undefined;

    while (parent) {
      value++;
      parent = parent.parentId ? find(parent.parentId) : undefined;
    }

    return value;
  };
  const subtreeDepth = (node: MockNode): number => {
    if (node.kind !== "folder") return 0;
    const folders = children(node.id).filter(
      (child) => child.kind === "folder",
    );

    return 1 + (folders.length ? Math.max(...folders.map(subtreeDepth)) : 0);
  };
  const pageFor = (
    parentId: string | null,
    limit: number,
    cursor?: string | null,
    space = "test-space",
  ) => {
    const all = children(parentId, space);
    const offset = cursor ? Number(cursor.split(":")[1] ?? 0) : 0;
    const items = all.slice(offset, offset + limit);

    return {
      parentId,
      items: items.map(serialize),
      total: all.length,
      nextCursor:
        offset + limit < all.length ? `${revision}:${offset + limit}` : null,
      catalogRevision: revision,
      hasPrevious: offset > 0,
    };
  };
  const pathFor = (node: MockNode) => {
    const chain: MockNode[] = [];

    let current: MockNode | undefined = node;

    while (current) {
      chain.unshift(current);
      current = current.parentId ? find(current.parentId) : undefined;
    }

    const ancestors = chain.slice(0, -1);
    const pages = chain.map((pathNode) => {
      const parentId = pathNode.parentId;
      const siblings = children(parentId, pathNode.workspaceId ?? "test-space");
      const start = siblings.findIndex((entry) => entry.id === pathNode.id);
      const items = siblings.slice(start, start + 30);

      return {
        parentId,
        items: items.map(serialize),
        total: siblings.length,
        nextCursor:
          start + 30 < siblings.length ? `${revision}:${start + 30}` : null,
        catalogRevision: revision,
        hasPrevious: start > 0,
      };
    });

    return {
      ancestors: ancestors.map(serialize),
      item: serialize(node),
      catalogRevision: revision,
      pages,
    };
  };
  const navigation = (canvasId: string | null) => ({
    revision: 0,
    lastWorkspaceId: "test-space",
    lastCanvasId: canvasId,
    workspaces: [{ workspaceId: "test-space", lastCanvasId: canvasId }],
  });
  const addFavorite = (node: MockNode, value: boolean) => {
    const key = nodeKey(node);
    const index = favorites.indexOf(key);

    if (value && index < 0) favorites.push(key);
    if (!value && index >= 0) favorites.splice(index, 1);
  };
  const removeNode = (node: MockNode) => {
    nodes.splice(nodes.indexOf(node), 1);
    addFavorite(node, false);

    return { affectedCanvasIds: [node.id], affectedFolderIds: [node.id] };
  };
  const moveNode = (body: {
    source: { kind: string; id: string };
    parentId: string | null;
    target?: { kind: string; id: string };
    placement: "before" | "after" | "end";
  }) => {
    const source = find(body.source.id);

    if (!source) return false;
    source.parentId = body.parentId;
    const siblings = children(body.parentId).filter(
      (node) => node.id !== source.id,
    );
    const targetIndex = body.target
      ? siblings.findIndex((node) => node.id === body.target!.id)
      : siblings.length;

    siblings.splice(
      targetIndex < 0
        ? siblings.length
        : targetIndex + (body.placement === "after" ? 1 : 0),
      0,
      source,
    );
    siblings.forEach((node, index) => {
      node.position = index;
    });

    return true;
  };

  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === "GET" ? undefined : request.postDataJSON();

    if (path === "/api/session") return route.fulfill({ json: { user } });
    if (path === "/api/logout") {
      logoutCalls++;

      return route.fulfill({ json: { ok: true } });
    }

    if (path === "/api/workspaces")
      return route.fulfill({
        json: {
          workspaces: spaces.map((space) => ({
            ...space,
            catalogRevision: revision,
            createdAt: now,
            updatedAt: now,
          })),
        },
      });
    if (path === "/api/navigation")
      return route.fulfill({
        json: navigation(
          method === "PUT"
            ? request.postDataJSON().canvasId
            : (options.recent ?? null),
        ),
      });
    if (path === "/api/shared-canvases")
      return route.fulfill({
        json: {
          canvases: Array.from({ length: options.shared ?? 0 }, (_, index) => ({
            ...nodes.find((node) => node.kind === "canvas")?.canvas,
            id: `shared-${index}`,
            name: `共享画布 ${index + 1}`,
            role: "viewer",
          })),
        },
      });
    const directory = path.match(/^\/api\/workspaces\/([^/]+)\/directory$/);

    if (directory && method === "GET") {
      const space = directory[1]!;
      const parentId = url.searchParams.get("parentId");
      const limit = Number(url.searchParams.get("limit") ?? 30);
      const cursor = url.searchParams.get("cursor");

      if (request.frame().page() === page)
        reads.push({ space, parentId, limit: String(limit), cursor });
      if (cursor) {
        if (appendGate) await appendGate;
        if (Number(cursor.split(":")[0]) !== revision) {
          conflicts++;

          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: "CATALOG_CONFLICT",
                message: "目录已在另一标签页修改",
              },
            },
          });
        }

        if (failNextAppend) {
          failNextAppend = false;

          return route.fulfill({
            status: 503,
            json: {
              error: { code: "TEST_UNAVAILABLE", message: "分页暂不可用" },
            },
          });
        }
      }

      return route.fulfill({ json: pageFor(parentId, limit, cursor, space) });
    }

    if (directory && method === "POST") {
      const space = directory[1]!;
      const parentId = (body as any).parentId ?? null;
      const node: MockNode = {
        kind: "canvas",
        workspaceId: space,
        id: `remote-${revision}`,
        name: (body as any).name,
        parentId,
        position: children(parentId, space).length,
      };

      nodes.push(node);
      revision++;

      return route.fulfill({ json: { canvas: canvasDoc(node) } });
    }

    if (/^\/api\/workspaces\/[^/]+\/directory\/path$/.test(path)) {
      const id = url.searchParams.get("id");
      const node = id ? find(id) : undefined;

      if (!node) return route.fallback();
      if (request.frame().page() === page)
        pathReads.push({
          kind: url.searchParams.get("kind"),
          id: url.searchParams.get("id"),
        });

      return route.fulfill({ json: pathFor(node) });
    }

    if (/^\/api\/workspaces\/[^/]+\/favorites$/.test(path)) {
      if (method === "GET")
        return route.fulfill({
          json: {
            items: favorites
              .map((key) => {
                const [kind, id] = key.split(":");

                return nodes.find(
                  (node) => node.kind === kind && node.id === id,
                );
              })
              .filter((node): node is MockNode => !!node)
              .map(serialize),
            catalogRevision: revision,
          },
        });

      const source = find((body as any).source.id);

      if (!source) return route.fallback();
      favoritesWrites.push(body);
      if (failFavorite)
        return route.fulfill({
          status: 409,
          json: {
            error: { code: "CATALOG_CONFLICT", message: "收藏未保存" },
          },
        });
      addFavorite(source, (body as any).favorite);
      revision++;

      return route.fulfill({
        json: { item: serialize(source), catalogRevision: revision },
      });
    }

    if (/^\/api\/workspaces\/[^/]+\/favorites\/order$/.test(path)) {
      const source = favorites.indexOf(nodeKey((body as any).source));
      const target = favorites.indexOf(nodeKey((body as any).target));

      if (source >= 0 && target >= 0) {
        favorites.splice(source, 1);
        favorites.splice(
          favorites.indexOf(nodeKey((body as any).target)) +
            ((body as any).placement === "after" ? 1 : 0),
          0,
          nodeKey((body as any).source),
        );
      }

      revision++;

      return route.fulfill({ json: { catalogRevision: revision } });
    }

    if (/^\/api\/workspaces\/[^/]+\/directory\/move$/.test(path)) {
      if (failNextMove) {
        failNextMove = false;

        return route.fulfill({
          status: 409,
          json: {
            error: { code: "CATALOG_CONFLICT", message: "排序未保存" },
          },
        });
      }

      if (!moveNode(body as any))
        return route.fulfill({
          status: 400,
          json: {
            error: { code: "INVALID_DIRECTORY_MOVE", message: "移动无效" },
          },
        });
      moves.push({ id: (body as any).source.id, body });
      revision++;

      return route.fulfill({ json: { catalogRevision: revision } });
    }

    const canvasPath = path.match(/^\/api\/canvases\/([^/]+)$/);

    if (canvasPath) {
      const node = find(canvasPath[1]!);

      if (!node || node.kind !== "canvas") return route.fallback();
      if (method === "DELETE") {
        removeNode(node);
        revision++;

        return route.fulfill({ json: { ok: true } });
      }

      if (method === "PUT") {
        saving.push(node.id);
        if (saveGate) await saveGate;
        canvasDoc(node).scene = request.postDataJSON().scene;
        canvasDoc(node).revision++;

        return route.fulfill({
          json: {
            revision: canvasDoc(node).revision,
            updatedAt: canvasDoc(node).updatedAt,
          },
        });
      }

      if (method === "PATCH") {
        const name = request.postDataJSON().name;

        renames.push({ id: node.id, name });
        if (failNextRename) {
          failNextRename = false;

          return route.fulfill({
            status: 503,
            json: {
              error: { code: "OFFLINE", message: "重命名暂时失败" },
            },
          });
        }

        node.name = name;
        node.canvas!.name = name;

        return route.fulfill({ json: { canvas: canvasDoc(node) } });
      }

      if (method === "GET") {
        opened.push(node.id);

        return route.fulfill({ json: { canvas: canvasDoc(node) } });
      }
    }

    const folderPath = path.match(/^\/api\/folders\/([^/]+)$/);

    if (folderPath && method === "DELETE") {
      const node = find(folderPath[1]!);

      if (!node) return route.fallback();

      return route.fulfill({ json: removeNode(node) });
    }

    if (
      /^\/api\/workspaces\/[^/]+\/canvases$/.test(path) &&
      method === "POST"
    ) {
      const node: MockNode = {
        kind: "canvas",
        id: `remote-${revision}`,
        name: (body as any).name,
        parentId: (body as any).parentId ?? null,
        position: children((body as any).parentId ?? null).length,
      };

      nodes.push(node);
      revision++;

      return route.fulfill({ json: { canvas: canvasDoc(node) } });
    }

    if (/^\/api\/workspaces\/[^/]+\/canvases$/.test(path) && method === "GET") {
      const workspaceId = decodeURIComponent(path.split("/")[3]!);
      const flat = nodes
        .filter(
          (node) =>
            node.kind === "canvas" &&
            (node.workspaceId ?? "test-space") === workspaceId,
        )
        .map((node, position) => ({
          ...canvasDoc(node),
          position,
        }));

      return route.fulfill({
        json: {
          canvases: flat,
          catalogRevision: revision,
          total: flat.length,
          nextCursor: null,
        },
      });
    }

    return route.fallback();
  });

  return {
    nodes,
    reads,
    pathReads,
    opened,
    moves,
    favoritesWrites,
    renames,
    saving,
    conflicts: () => conflicts,
    revisions: () => revision,
    logoutCalls: () => logoutCalls,
    favorites: () => favorites,
    orderedIds: (parentId: string | null = null) =>
      children(parentId).map((node) => node.id),
    saved: (index: number) => nodes[index]!.canvas?.scene.elements.length ?? 0,
    failAppend: () => {
      failNextAppend = true;
    },
    failFavorite: (value: boolean) => {
      failFavorite = value;
    },
    failMove: () => {
      failNextMove = true;
    },
    failRename: () => {
      failNextRename = true;
    },
    holdAppend: () => {
      appendGate = new Promise<void>((resolveGate) => {
        releaseAppend = resolveGate;
      });
    },
    releaseAppend: () => {
      appendGate = undefined;
      releaseAppend?.();
    },
    holdSave: () => {
      saveGate = new Promise<void>((resolveGate) => {
        releaseSave = resolveGate;
      });
    },
    releaseSave: () => {
      saveGate = undefined;
      releaseSave?.();
    },
    changeUser: (id: string) => {
      user = { ...user, id };
    },
  };
};
