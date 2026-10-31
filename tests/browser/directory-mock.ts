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

  // 批量接口替身：服务端权威 normalize、每 folder root 独立批次、ordinal 撤销与 no-op 判定。
  let batchSeq = 0;
  let failBatch: { status: number; code: string; message: string } | undefined;
  let dropNextBatchDelete = false;
  let failDirectoryReads = false;
  const events: { method: string; path: string; body: unknown }[] = [];
  const bin: { node: MockNode; batchId: string | null }[] = [];
  const ancestorKeys = (node: MockNode) => {
    const keys: string[] = [];
    let parent = node.parentId ? find(node.parentId) : undefined;

    while (parent) {
      keys.push(nodeKey(parent));
      parent = parent.parentId ? find(parent.parentId) : undefined;
    }

    return keys;
  };
  const subtreeNodes = (node: MockNode): MockNode[] => {
    if (node.kind === "canvas") return [node];
    const result: MockNode[] = [node];

    for (let index = 0; index < result.length; index++)
      for (const child of nodes)
        if (child.parentId === result[index]!.id) result.push(child);

    return result;
  };
  const normalizeBatch = (sources: { kind: string; id: string }[]) => {
    const refs = sources.filter(
      (source, index, all) =>
        all.findIndex(
          (entry) => entry.kind === source.kind && entry.id === source.id,
        ) === index,
    );
    const missing = refs.filter(
      (source) => find(source.id)?.kind !== source.kind,
    );

    if (missing.length) return { missing, roots: [] as MockNode[] };
    const wanted = new Set(refs.map((source) => nodeKey(source)));

    return {
      missing: [] as MockNode[],
      roots: refs
        .map((source) => find(source.id)!)
        .filter((node) => !ancestorKeys(node).some((key) => wanted.has(key))),
    };
  };
  const batchCounts = (roots: MockNode[]) => {
    const folders = new Set<string>();
    const canvases = new Set<string>();

    for (const root of roots)
      for (const node of subtreeNodes(root))
        if (node.kind === "folder") folders.add(node.id);
        else canvases.add(node.id);

    return { folderCount: folders.size, canvasCount: canvases.size };
  };
  const mixOrder = (parentId: string | null) =>
    children(parentId, "test-space")
      .map((node) => nodeKey(node))
      .join(",");
  const ordinalOf = (node: MockNode) => children(node.parentId).indexOf(node);
  const snapshotLayout = () =>
    nodes.map((node) => ({
      node,
      parentId: node.parentId,
      position: node.position,
    }));
  const restoreLayout = (
    snapshot: { node: MockNode; parentId: string | null; position?: number }[],
  ) => {
    for (const entry of snapshot) {
      entry.node.parentId = entry.parentId;
      entry.node.position = entry.position;
    }
  };
  const batchMove = (input: {
    sources: { kind: string; id: string }[];
    parentId: string | null;
    target?: { kind: string; id: string };
    placement: "before" | "after" | "end";
  }) => {
    const normalized = normalizeBatch(input.sources ?? []);

    if (!normalized.roots.length)
      return {
        error: {
          status: 400,
          code: "INVALID_DIRECTORY_BATCH",
          message: "批量来源无效",
        },
      };
    if (normalized.missing.length)
      return {
        error: { status: 404, code: "NOT_FOUND", message: "目录项目不存在" },
      };
    const parent = input.parentId ? find(input.parentId) : undefined;

    if (input.parentId && parent?.kind !== "folder")
      return {
        error: {
          status: 400,
          code: "INVALID_DIRECTORY_MOVE",
          message: "目标父级不是文件夹",
        },
      };
    const sourceKeys = new Set(normalized.roots.map((node) => nodeKey(node)));
    const parentKeys = parent ? [nodeKey(parent), ...ancestorKeys(parent)] : [];

    if (parentKeys.some((key) => sourceKeys.has(key)))
      return {
        error: {
          status: 400,
          code: "INVALID_DIRECTORY_MOVE",
          message: "不能移动到自身或子文件夹",
        },
      };
    const parentDepth = parent ? depth(parent) : 0;
    const deepest = Math.max(
      ...normalized.roots.map((root) => subtreeDepth(root)),
    );

    if (parentDepth + deepest > 5)
      return {
        error: {
          status: 400,
          code: "FOLDER_DEPTH_LIMIT",
          message: "移动后文件夹将超过五层限制",
        },
      };
    const siblings = children(input.parentId).filter(
      (node) => !sourceKeys.has(nodeKey(node)),
    );

    if (input.placement !== "end" && !input.target)
      return {
        error: {
          status: 400,
          code: "INVALID_DIRECTORY_MOVE",
          message: "缺少目标位置",
        },
      };
    if (
      input.target &&
      !siblings.some((node) => nodeKey(node) === nodeKey(input.target!))
    )
      return {
        error: {
          status: 400,
          code: "INVALID_DIRECTORY_MOVE",
          message: "目标不是该目录的直接子项",
        },
      };
    const watched = new Set<string | null>([input.parentId]);

    for (const root of normalized.roots) watched.add(root.parentId);
    const before = new Map<string | null, string>();

    for (const key of watched) before.set(key, mixOrder(key));
    const origins = normalized.roots.map((root) => ({
      source: { kind: root.kind, id: root.id },
      parentId: root.parentId,
      index: ordinalOf(root),
    }));
    const targetIndex = input.target
      ? siblings.findIndex((node) => nodeKey(node) === nodeKey(input.target!))
      : siblings.length;
    const ordered = [...siblings];
    const insertAt =
      input.placement === "end"
        ? ordered.length
        : targetIndex + (input.placement === "after" ? 1 : 0);

    ordered.splice(insertAt, 0, ...normalized.roots);
    const snapshot = snapshotLayout();

    for (const root of normalized.roots) root.parentId = input.parentId;
    ordered.forEach((node, index) => {
      node.position = index;
    });
    for (const key of watched)
      if (key !== input.parentId)
        children(key).forEach((node, index) => {
          node.position = index;
        });
    const changed = [...watched].some(
      (key) => before.get(key) !== mixOrder(key),
    );

    if (!changed) {
      restoreLayout(snapshot);

      return {
        changed: false,
        normalizedSources: normalized.roots.map((root) => ({
          kind: root.kind,
          id: root.id,
        })),
        catalogRevision: revision,
        undo: null,
      };
    }

    revision++;

    return {
      changed: true,
      normalizedSources: normalized.roots.map((root) => ({
        kind: root.kind,
        id: root.id,
      })),
      catalogRevision: revision,
      undo: {
        kind: "move" as const,
        expectedCatalogRevision: revision,
        destinationParentId: input.parentId,
        origins,
      },
    };
  };
  const batchDelete = (sources: { kind: string; id: string }[]) => {
    const normalized = normalizeBatch(sources ?? []);

    if (!normalized.roots.length)
      return {
        error: {
          status: 400,
          code: "INVALID_DIRECTORY_BATCH",
          message: "批量来源无效",
        },
      };
    if (normalized.missing.length)
      return {
        error: { status: 404, code: "NOT_FOUND", message: "目录项目不存在" },
      };
    const roots = normalized.roots.map((root) => ({
      root,
      deleteBatchId: root.kind === "folder" ? `batch-${++batchSeq}` : null,
    }));
    const affectedFolderIds: string[] = [];
    const affectedCanvasIds: string[] = [];

    for (const entry of roots)
      for (const node of subtreeNodes(entry.root)) {
        const index = nodes.indexOf(node);

        if (index >= 0) nodes.splice(index, 1);
        bin.push({ node, batchId: entry.deleteBatchId });
        if (node.kind === "folder") affectedFolderIds.push(node.id);
        else affectedCanvasIds.push(node.id);
      }

    revision++;

    return {
      catalogRevision: revision,
      normalizedSources: normalized.roots.map((root) => ({
        kind: root.kind,
        id: root.id,
      })),
      receipt: {
        kind: "delete" as const,
        expectedCatalogRevision: revision,
        roots: roots.map((entry) => ({
          root: { kind: entry.root.kind, id: entry.root.id },
          deleteBatchId: entry.deleteBatchId,
        })),
      },
      affectedFolderIds,
      affectedCanvasIds,
    };
  };
  const batchUndo = (receipt: any) => {
    if (
      !receipt ||
      typeof receipt !== "object" ||
      (receipt.kind !== "move" && receipt.kind !== "delete")
    )
      return {
        status: 400,
        code: "INVALID_DIRECTORY_BATCH",
        message: "撤销回执结构无效",
      };

    if (typeof receipt.expectedCatalogRevision !== "number")
      return {
        status: 400,
        code: "INVALID_DIRECTORY_BATCH",
        message: "撤销回执缺少目录版本",
      };
    if (receipt.expectedCatalogRevision !== revision)
      return {
        status: 409,
        code: "DIRECTORY_UNDO_CONFLICT",
        message: "目录已更新，请在回收站中恢复",
      };

    if (receipt.kind === "delete") {
      if (!Array.isArray(receipt.roots) || !receipt.roots.length)
        return {
          status: 400,
          code: "INVALID_DIRECTORY_BATCH",
          message: "撤销回执结构无效",
        };
      const restoredFolderIds: string[] = [];
      const restoredCanvasIds: string[] = [];
      const pending: { node: MockNode; batchId: string | null }[] = [];

      for (const entry of receipt.roots) {
        if (!entry?.root || typeof entry.root.id !== "string")
          return {
            status: 400,
            code: "INVALID_DIRECTORY_BATCH",
            message: "撤销回执结构无效",
          };
        const matches = bin.filter((row) =>
          entry.root.kind === "folder"
            ? row.batchId !== null && row.batchId === entry.deleteBatchId
            : row.node.kind === "canvas" &&
              row.node.id === entry.root.id &&
              row.batchId === null,
        );

        if (!matches.length)
          return {
            status: 409,
            code: "DIRECTORY_UNDO_CONFLICT",
            message: "部分项目已恢复或已彻底删除",
          };
        pending.push(...matches);
      }

      for (const row of pending) {
        bin.splice(bin.indexOf(row), 1);
        nodes.push(row.node);
        if (row.node.kind === "folder") restoredFolderIds.push(row.node.id);
        else restoredCanvasIds.push(row.node.id);
      }

      revision++;

      return {
        kind: "delete" as const,
        catalogRevision: revision,
        restoredFolderIds,
        restoredCanvasIds,
      };
    }

    const origins: {
      source: { kind: string; id: string };
      parentId: string | null;
      index: number;
    }[] = Array.isArray(receipt.origins) ? receipt.origins : [];

    if (!origins.length)
      return {
        status: 400,
        code: "INVALID_DIRECTORY_BATCH",
        message: "撤销回执结构无效",
      };
    if (
      receipt.destinationParentId !== null &&
      typeof receipt.destinationParentId !== "string"
    )
      return {
        status: 400,
        code: "INVALID_DIRECTORY_BATCH",
        message: "撤销回执结构无效",
      };
    const seen = new Set<string>();

    for (const origin of origins) {
      if (
        !origin?.source ||
        !Number.isInteger(origin.index) ||
        origin.index < 0
      )
        return {
          status: 400,
          code: "INVALID_DIRECTORY_BATCH",
          message: "撤销回执结构无效",
        };
      const key = nodeKey(origin.source);

      if (seen.has(key))
        return {
          status: 409,
          code: "DIRECTORY_UNDO_CONFLICT",
          message: "撤销回执重复",
        };
      seen.add(key);
      const node = find(origin.source.id);

      if (
        !node ||
        node.kind !== origin.source.kind ||
        node.parentId !== receipt.destinationParentId
      )
        return {
          status: 409,
          code: "DIRECTORY_UNDO_CONFLICT",
          message: "项目已不在预期位置",
        };
      if (origin.parentId && find(origin.parentId)?.kind !== "folder")
        return {
          status: 409,
          code: "DIRECTORY_UNDO_CONFLICT",
          message: "原位置已不可用",
        };
      if (origin.index > children(origin.parentId).length)
        return {
          status: 409,
          code: "DIRECTORY_UNDO_CONFLICT",
          message: "原序位不可用",
        };
    }

    const buckets = new Map<
      string | null,
      { node: MockNode; index: number }[]
    >();

    for (const origin of origins) {
      const node = find(origin.source.id)!;
      const bucket = buckets.get(origin.parentId) ?? [];

      bucket.push({ node, index: origin.index });
      buckets.set(origin.parentId, bucket);
    }

    for (const [parentId, bucket] of buckets) {
      const current = children(parentId).filter(
        (node) => !bucket.some((entry) => entry.node === node),
      );

      for (const entry of [...bucket].sort((a, b) => a.index - b.index)) {
        entry.node.parentId = parentId;
        current.splice(Math.min(entry.index, current.length), 0, entry.node);
      }

      current.forEach((node, index) => {
        node.position = index;
      });
    }

    revision++;

    return { kind: "move" as const, catalogRevision: revision };
  };

  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === "GET" ? undefined : request.postDataJSON();
    const failWith = (status: number, code: string, message: string) =>
      route.fulfill({ status, json: { error: { code, message } } });

    events.push({ method, path, body });

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
      if (failDirectoryReads) {
        return route.fulfill({
          status: 503,
          json: {
            error: { code: "TEST_UNAVAILABLE", message: "目录暂不可用" },
          },
        });
      }

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

    const batchPath = path.match(
      /^\/api\/workspaces\/[^/]+\/directory\/batch\/(summary|move|delete|undo)$/,
    );

    if (batchPath) {
      const action = batchPath[1]!;

      if (failBatch) {
        const failure = failBatch;

        failBatch = undefined;

        return failWith(failure.status, failure.code, failure.message);
      }

      if ((body as any)?.catalogRevision !== revision && action !== "undo")
        return failWith(409, "CATALOG_CONFLICT", "目录已更新，请重新加载");

      if (action === "summary") {
        const normalized = normalizeBatch((body as any)?.sources ?? []);

        if (!Array.isArray((body as any)?.sources) || !normalized.roots.length)
          return failWith(400, "INVALID_DIRECTORY_BATCH", "批量来源无效");
        if (normalized.missing.length)
          return failWith(404, "NOT_FOUND", "目录项目不存在");

        return route.fulfill({
          json: {
            normalizedSources: normalized.roots.map((root) => ({
              kind: root.kind,
              id: root.id,
            })),
            ...batchCounts(normalized.roots),
            catalogRevision: revision,
          },
        });
      }

      if (action === "move") {
        const result = batchMove(body as any);

        if ("error" in result) {
          const error = result.error as {
            status: number;
            code: string;
            message: string;
          };

          return failWith(error.status, error.code, error.message);
        }

        return route.fulfill({ json: result });
      }

      if (action === "delete") {
        const result = batchDelete((body as any)?.sources ?? []);

        if ("error" in result) {
          const error = result.error as {
            status: number;
            code: string;
            message: string;
          };

          return failWith(error.status, error.code, error.message);
        }

        if (dropNextBatchDelete) {
          dropNextBatchDelete = false;

          // 已提交但响应丢失：客户端只能标未确认并刷新核实。
          return route.abort("failed");
        }

        return route.fulfill({ json: result });
      }

      const undone = batchUndo((body as any)?.receipt);

      if ("status" in undone) {
        const failure = undone as {
          status: number;
          code: string;
          message: string;
        };

        return failWith(failure.status, failure.code, failure.message);
      }

      return route.fulfill({ json: undone });
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
    /** 请求顺序记录，用于断言“先保存草稿再批删”等时序。 */
    events,
    batchWrites: () =>
      events.filter((entry) => entry.path.includes("/directory/batch/")),
    /** 仍在回收站（已移出活动目录）的节点 id。 */
    recycled: () => bin.map((entry) => entry.node.id),
    failNextBatch: (
      status = 409,
      code = "DIRECTORY_UNDO_CONFLICT",
      message = "目录已更新，请在回收站中恢复",
    ) => {
      failBatch = { status, code, message };
    },
    dropNextBatchDelete: () => {
      dropNextBatchDelete = true;
    },
    /** 粘性开关：让后续所有目录读取失败，直到显式恢复（避免被无关读提前消费）。 */
    failDirectoryReads: (value = true) => {
      failDirectoryReads = value;
    },
  };
};
