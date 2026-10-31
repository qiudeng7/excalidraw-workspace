import { db } from "@nuxthub/db";
import {
  and,
  asc,
  count,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import * as tables from "#server/db/schema";
import type {
  DirectoryCanvasNode,
  DirectoryFolderNode,
  DirectoryNode,
  DirectoryPage,
  MoveDirectoryRequest,
  DirectoryPath,
  NodeRef,
  RestoreCanvasResponse,
  RestoreDirectoryRequest,
  RestoreFolderResponse,
} from "#shared/directory-contracts";
import { ApiError, fail } from "#server/utils/http";

interface DirectoryCursor {
  version: 1;
  workspaceId: string;
  parentId: string | null;
  catalogRevision: number;
  position: number;
  id: string;
  kind: "folder" | "canvas";
}

const ownerWorkspace = (workspaceId: string, userId: string) =>
  and(
    eq(tables.workspaces.id, workspaceId),
    eq(tables.workspaces.userId, userId),
    eq(tables.workspaces.deleting, 0),
    isNull(tables.workspaces.deletedAt),
  );

const ownedFolder = (workspaceId: string, id: string) =>
  and(
    eq(tables.folders.id, id),
    eq(tables.folders.workspaceId, workspaceId),
    isNull(tables.folders.deletedAt),
  );

const encodeCursor = (cursor: DirectoryCursor) =>
  btoa(encodeURIComponent(JSON.stringify(cursor)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const decodeCursor = (
  value: string,
  workspaceId: string,
  parentId: string | null,
): DirectoryCursor => {
  try {
    if (value.length > 2048 || !/^[\w-]+$/.test(value)) throw Error();
    const parsed: unknown = JSON.parse(
      decodeURIComponent(atob(value.replace(/-/g, "+").replace(/_/g, "/"))),
    );

    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as DirectoryCursor).version !== 1 ||
      (parsed as DirectoryCursor).workspaceId !== workspaceId ||
      (parsed as DirectoryCursor).parentId !== parentId ||
      !Number.isSafeInteger((parsed as DirectoryCursor).catalogRevision) ||
      !Number.isSafeInteger((parsed as DirectoryCursor).position) ||
      typeof (parsed as DirectoryCursor).id !== "string" ||
      !["folder", "canvas"].includes((parsed as DirectoryCursor).kind)
    )
      throw Error();

    return parsed as DirectoryCursor;
  } catch (error) {
    throw new ApiError(400, "INVALID_CURSOR", "目录分页游标无效", {
      cause: error,
    });
  }
};

const cursorFilter = (cursor: DirectoryCursor | undefined) => {
  if (!cursor) return undefined;

  return or(
    gt(tables.folders.position, cursor.position),
    and(
      eq(tables.folders.position, cursor.position),
      gt(tables.folders.id, cursor.id),
    ),
    cursor.kind === "canvas"
      ? and(
          eq(tables.folders.position, cursor.position),
          eq(tables.folders.id, cursor.id),
        )
      : undefined,
  );
};

const canvasCursorFilter = (cursor: DirectoryCursor | undefined) => {
  if (!cursor) return undefined;

  return or(
    gt(tables.canvases.position, cursor.position),
    and(
      eq(tables.canvases.position, cursor.position),
      gt(tables.canvases.id, cursor.id),
    ),
  );
};

const mapFolder = (
  row: typeof tables.folders.$inferSelect,
): DirectoryFolderNode => ({
  kind: "folder",
  id: row.id,
  workspaceId: row.workspaceId,
  parentId: row.parentId,
  name: row.name,
  position: row.position,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  favorite: false,
  depth: 1,
  childCount: 0,
  subtreeDepth: 1,
});

const mapCanvas = (
  row: typeof tables.canvases.$inferSelect,
): DirectoryCanvasNode => {
  const {
    objectKey: _objectKey,
    parentId,
    deleteBatchId: _deleteBatchId,
    ...canvas
  } = row;

  return {
    kind: "canvas",
    id: row.id,
    workspaceId: row.workspaceId,
    parentId,
    name: row.name,
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    favorite: false,
    canvas,
  };
};

const binaryCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const sortNodes = (a: DirectoryNode, b: DirectoryNode) =>
  a.position - b.position ||
  binaryCompare(a.id, b.id) ||
  binaryCompare(a.kind, b.kind);

const decorateFolderNodes = async (
  workspaceId: string,
  nodes: DirectoryNode[],
): Promise<DirectoryNode[]> => {
  const foldersInPage = nodes.filter(
    (node): node is DirectoryFolderNode => node.kind === "folder",
  );

  if (!foldersInPage.length) return nodes;

  const folderMap = new Map<string, { parentId: string | null }>();
  let pending = foldersInPage.map((folder) => folder.id);

  for (let level = 1; pending.length && level <= 5; level += 1) {
    const rows = await db
      .select({ id: tables.folders.id, parentId: tables.folders.parentId })
      .from(tables.folders)
      .where(
        and(
          eq(tables.folders.workspaceId, workspaceId),
          inArray(tables.folders.id, pending),
          isNull(tables.folders.deletedAt),
        ),
      );
    const next = new Set<string>();

    for (const row of rows) {
      folderMap.set(row.id, { parentId: row.parentId });
      if (row.parentId) next.add(row.parentId);
    }

    pending = [...next].filter((id) => !folderMap.has(id));
  }

  const subtreeDepths = new Map(foldersInPage.map((folder) => [folder.id, 1]));
  let frontier = new Map(foldersInPage.map((folder) => [folder.id, folder.id]));

  for (let level = 2; frontier.size && level <= 5; level += 1) {
    const childRows = await db
      .select({ id: tables.folders.id, parentId: tables.folders.parentId })
      .from(tables.folders)
      .where(
        and(
          eq(tables.folders.workspaceId, workspaceId),
          inArray(tables.folders.parentId, [...frontier.keys()]),
          isNull(tables.folders.deletedAt),
        ),
      );
    const next = new Map<string, string>();

    for (const row of childRows) {
      const root = row.parentId ? frontier.get(row.parentId) : undefined;

      if (!root) continue;
      subtreeDepths.set(root, level);
      next.set(row.id, root);
    }

    frontier = next;
  }

  const ids = foldersInPage.map((folder) => folder.id);
  const [folderChildren, canvasChildren] = await db.batch([
    db
      .select({ parentId: tables.folders.parentId, total: count() })
      .from(tables.folders)
      .where(
        and(
          eq(tables.folders.workspaceId, workspaceId),
          inArray(tables.folders.parentId, ids),
          isNull(tables.folders.deletedAt),
        ),
      )
      .groupBy(tables.folders.parentId),
    db
      .select({ parentId: tables.canvases.parentId, total: count() })
      .from(tables.canvases)
      .where(
        and(
          eq(tables.canvases.workspaceId, workspaceId),
          inArray(tables.canvases.parentId, ids),
          isNull(tables.canvases.deletedAt),
        ),
      )
      .groupBy(tables.canvases.parentId),
  ]);
  const childCounts = new Map<string, number>();

  for (const row of [...folderChildren, ...canvasChildren]) {
    if (row.parentId)
      childCounts.set(
        row.parentId,
        (childCounts.get(row.parentId) ?? 0) + row.total,
      );
  }

  return nodes.map((node) => {
    if (node.kind !== "folder") return node;
    let depth = 1;
    let parentId = folderMap.get(node.id)?.parentId;

    while (parentId && depth <= 5) {
      depth += 1;
      parentId = folderMap.get(parentId)?.parentId;
    }

    return {
      ...node,
      depth,
      childCount: childCounts.get(node.id) ?? 0,
      subtreeDepth: subtreeDepths.get(node.id) ?? 1,
    };
  });
};

export async function createDirectoryFolder(
  id: string,
  workspaceId: string,
  userId: string,
  parentId: string | null,
  name: string,
  now: string,
  catalogRevision: number,
) {
  let depth = 0;
  let ancestorId = parentId;

  while (ancestorId) {
    const ancestor = (
      await db
        .select({ id: tables.folders.id, parentId: tables.folders.parentId })
        .from(tables.folders)
        .where(ownedFolder(workspaceId, ancestorId))
        .limit(1)
    )[0];

    if (!ancestor) return fail(404, "NOT_FOUND", "目标文件夹不存在");
    depth += 1;
    ancestorId = ancestor.parentId;
  }

  if (depth >= 5) fail(400, "FOLDER_DEPTH_LIMIT", "文件夹最多嵌套五层");

  const sameParentFolder =
    parentId === null ? sql`parent_id IS NULL` : sql`parent_id = ${parentId}`;
  const sameParentCanvas =
    parentId === null ? sql`parent_id IS NULL` : sql`parent_id = ${parentId}`;
  const position = sql<number>`COALESCE((
    SELECT MAX(position) + 1 FROM (
      SELECT position FROM folders WHERE workspace_id = ${workspaceId} AND ${sameParentFolder} AND deleted_at IS NULL
      UNION ALL
      SELECT position FROM canvases WHERE workspace_id = ${workspaceId} AND ${sameParentCanvas} AND deleted_at IS NULL
    )
  ), 0)`;
  const result = await db.batch([
    db.insert(tables.folders).select(
      db
        .select({
          id: sql<string>`${id}`.as("id"),
          workspaceId: tables.workspaces.id,
          parentId: sql<string | null>`${parentId}`.as("parentId"),
          name: sql<string>`${name}`.as("name"),
          position: position.as("position"),
          createdAt: sql<string>`${now}`.as("createdAt"),
          updatedAt: sql<string>`${now}`.as("updatedAt"),
          deletedAt: sql<string | null>`NULL`.as("deletedAt"),
          deleteBatchId: sql<string | null>`NULL`.as("deleteBatchId"),
          purging: sql<number>`0`.as("purging"),
        })
        .from(tables.workspaces)
        .where(
          and(
            ownerWorkspace(workspaceId, userId),
            eq(tables.workspaces.catalogRevision, catalogRevision),
            parentId === null
              ? undefined
              : sql`EXISTS (
        SELECT 1 FROM folders WHERE id = ${parentId}
          AND workspace_id = ${workspaceId} AND deleted_at IS NULL
      )`,
          ),
        ),
    ),
    db
      .update(tables.workspaces)
      .set({
        catalogRevision: sql`${tables.workspaces.catalogRevision} + 1`,
      })
      .where(
        and(
          ownerWorkspace(workspaceId, userId),
          eq(tables.workspaces.catalogRevision, catalogRevision),
          parentId === null
            ? undefined
            : sql`EXISTS (
        SELECT 1 FROM folders WHERE id = ${parentId}
          AND workspace_id = ${workspaceId} AND deleted_at IS NULL
      )`,
        ),
      )
      .returning({ catalogRevision: tables.workspaces.catalogRevision }),
  ]);

  return result[1][0]?.catalogRevision ?? null;
}

const hydrateDirectoryNodes = async (
  workspaceId: string,
  nodes: DirectoryNode[],
): Promise<DirectoryNode[]> => {
  const decorated = await decorateFolderNodes(workspaceId, nodes);

  if (!decorated.length) return decorated;
  const favorites = await db
    .select({
      itemKind: tables.directoryFavorites.itemKind,
      itemId: tables.directoryFavorites.itemId,
    })
    .from(tables.directoryFavorites)
    .where(
      and(
        eq(tables.directoryFavorites.workspaceId, workspaceId),
        or(
          ...decorated.map((node) =>
            and(
              eq(tables.directoryFavorites.itemKind, node.kind),
              eq(tables.directoryFavorites.itemId, node.id),
            ),
          ),
        ),
      ),
    );
  const keys = new Set(favorites.map((row) => `${row.itemKind}:${row.itemId}`));

  return decorated.map((node) => ({
    ...node,
    favorite: keys.has(`${node.kind}:${node.id}`),
  }));
};

export async function directoryItem(
  workspaceId: string,
  userId: string,
  ref: NodeRef,
): Promise<DirectoryNode | null> {
  if (
    !(
      await db
        .select({ id: tables.workspaces.id })
        .from(tables.workspaces)
        .where(ownerWorkspace(workspaceId, userId))
        .limit(1)
    ).length
  )
    return null;

  if (ref.kind === "folder") {
    const row = (
      await db
        .select()
        .from(tables.folders)
        .where(ownedFolder(workspaceId, ref.id))
        .limit(1)
    )[0];

    return row
      ? (await hydrateDirectoryNodes(workspaceId, [mapFolder(row)]))[0]!
      : null;
  }

  const row = (
    await db
      .select()
      .from(tables.canvases)
      .where(
        and(
          eq(tables.canvases.id, ref.id),
          eq(tables.canvases.workspaceId, workspaceId),
          isNull(tables.canvases.deletedAt),
        ),
      )
      .limit(1)
  )[0];

  return row
    ? (await hydrateDirectoryNodes(workspaceId, [mapCanvas(row)]))[0]!
    : null;
}

const activeFolderSubtree = async (workspaceId: string, rootId: string) => {
  const result: (typeof tables.folders.$inferSelect)[] = [];
  let pending = [rootId];

  while (pending.length) {
    const rows = await db
      .select()
      .from(tables.folders)
      .where(
        and(
          eq(tables.folders.workspaceId, workspaceId),
          inArray(tables.folders.id, pending),
          isNull(tables.folders.deletedAt),
        ),
      );
    const fresh = rows.filter(
      (row) => !result.some((item) => item.id === row.id),
    );

    if (!fresh.length) break;
    result.push(...fresh);
    pending = (
      await db
        .select({ id: tables.folders.id })
        .from(tables.folders)
        .where(
          and(
            eq(tables.folders.workspaceId, workspaceId),
            inArray(
              tables.folders.parentId,
              fresh.map((row) => row.id),
            ),
            isNull(tables.folders.deletedAt),
          ),
        )
    ).map((row) => row.id);
  }

  return result;
};

export async function hasActiveFolders(workspaceId: string) {
  return !!(
    await db
      .select({ id: tables.folders.id })
      .from(tables.folders)
      .where(
        and(
          eq(tables.folders.workspaceId, workspaceId),
          isNull(tables.folders.deletedAt),
        ),
      )
      .limit(1)
  ).length;
}

export async function ownedFolderLocation(id: string, userId: string) {
  return (
    (
      await db
        .select({
          workspaceId: tables.folders.workspaceId,
          catalogRevision: tables.workspaces.catalogRevision,
        })
        .from(tables.folders)
        .innerJoin(
          tables.workspaces,
          eq(tables.workspaces.id, tables.folders.workspaceId),
        )
        .where(
          and(
            eq(tables.folders.id, id),
            isNull(tables.folders.deletedAt),
            eq(tables.workspaces.userId, userId),
            eq(tables.workspaces.deleting, 0),
            isNull(tables.workspaces.deletedAt),
          ),
        )
        .limit(1)
    )[0] ?? null
  );
}

export async function folderSummary(
  id: string,
  workspaceId: string,
  userId: string,
) {
  const folder = (
    await db
      .select({ id: tables.folders.id })
      .from(tables.folders)
      .innerJoin(
        tables.workspaces,
        eq(tables.folders.workspaceId, tables.workspaces.id),
      )
      .where(
        and(ownedFolder(workspaceId, id), ownerWorkspace(workspaceId, userId)),
      )
      .limit(1)
  )[0];

  if (!folder) return null;
  const descendants = await activeFolderSubtree(workspaceId, id);
  const ids = descendants.map((row) => row.id);
  const [canvasRows, revisionRows] = await db.batch([
    ids.length
      ? db
          .select({ total: count() })
          .from(tables.canvases)
          .where(
            and(
              eq(tables.canvases.workspaceId, workspaceId),
              inArray(tables.canvases.parentId, ids),
              isNull(tables.canvases.deletedAt),
            ),
          )
      : db
          .select({ total: count() })
          .from(tables.canvases)
          .where(eq(tables.canvases.id, "")),
    db
      .select({ catalogRevision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(ownerWorkspace(workspaceId, userId)),
  ]);
  const revision = revisionRows[0]?.catalogRevision;

  if (revision === undefined) return null;

  return {
    folderCount: Math.max(0, descendants.length - 1),
    canvasCount: canvasRows[0]!.total,
    catalogRevision: revision,
  };
}

export async function recycleFolderTree(
  id: string,
  workspaceId: string,
  userId: string,
  catalogRevision: number,
  now = new Date().toISOString(),
) {
  const subtree = await activeFolderSubtree(workspaceId, id);

  if (!subtree.length) return null;
  const folderIds = subtree.map((row) => row.id);
  const canvasRows = await db
    .select({ id: tables.canvases.id })
    .from(tables.canvases)
    .where(
      and(
        eq(tables.canvases.workspaceId, workspaceId),
        inArray(tables.canvases.parentId, folderIds),
        isNull(tables.canvases.deletedAt),
      ),
    );
  const batchId = crypto.randomUUID();
  const validWorkspace = sql`EXISTS (
    SELECT 1 FROM workspaces WHERE id = ${workspaceId} AND user_id = ${userId}
      AND deleting = 0 AND deleted_at IS NULL AND catalog_revision = ${catalogRevision}
  )`;
  const results = await db.batch([
    db
      .update(tables.folders)
      .set({ deletedAt: now, deleteBatchId: batchId })
      .where(
        and(
          inArray(tables.folders.id, folderIds),
          isNull(tables.folders.deletedAt),
          validWorkspace,
        ),
      ),
    db
      .update(tables.canvases)
      .set({
        deletedAt: now,
        deleteBatchId: batchId,
        revision: sql`${tables.canvases.revision} + 1`,
        recycleRevision: sql`${tables.canvases.recycleRevision} + 1`,
        recyclePending: 1,
      })
      .where(
        and(
          inArray(
            tables.canvases.id,
            canvasRows.map((row) => row.id),
          ),
          isNull(tables.canvases.deletedAt),
          validWorkspace,
        ),
      )
      .returning({ id: tables.canvases.id }),
    db
      .update(tables.userNavigation)
      .set({
        lastCanvasId: null,
        revision: sql`${tables.userNavigation.revision} + 1`,
      })
      .where(
        and(
          eq(tables.userNavigation.userId, userId),
          inArray(
            tables.userNavigation.lastCanvasId,
            canvasRows.map((row) => row.id),
          ),
          validWorkspace,
        ),
      ),
    db
      .update(tables.workspaceNavigation)
      .set({ lastCanvasId: null })
      .where(
        and(
          eq(tables.workspaceNavigation.userId, userId),
          eq(tables.workspaceNavigation.workspaceId, workspaceId),
          inArray(
            tables.workspaceNavigation.lastCanvasId,
            canvasRows.map((row) => row.id),
          ),
          validWorkspace,
        ),
      ),
    db.delete(tables.canvasSessions).where(
      and(
        inArray(
          tables.canvasSessions.canvasId,
          canvasRows.map((row) => row.id),
        ),
        validWorkspace,
      ),
    ),
    db
      .update(tables.workspaces)
      .set({ catalogRevision: sql`${tables.workspaces.catalogRevision} + 1` })
      .where(validWorkspace)
      .returning({ catalogRevision: tables.workspaces.catalogRevision }),
  ]);

  if (!results[5].length) return null;

  return {
    catalogRevision: results[5][0]!.catalogRevision,
    affectedCanvasIds: results[1].map((row) => row.id),
    affectedFolderIds: folderIds,
  };
}

export async function moveDirectoryItem(
  workspaceId: string,
  userId: string,
  move: MoveDirectoryRequest,
) {
  const source = await directoryItem(workspaceId, userId, move.source);

  if (!source) return null;
  const location = (
    await db
      .select({ catalogRevision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(ownerWorkspace(workspaceId, userId))
      .limit(1)
  )[0];

  if (!location || location.catalogRevision !== move.catalogRevision)
    return null;

  let subtreeFolders: (typeof tables.folders.$inferSelect)[] = [];

  if (source.kind === "folder") {
    subtreeFolders = await activeFolderSubtree(workspaceId, source.id);
    const subtreeIds = new Set(subtreeFolders.map((row) => row.id));

    if (move.parentId && subtreeIds.has(move.parentId))
      return fail(
        400,
        "INVALID_DIRECTORY_MOVE",
        "不能将文件夹移动到自身或子文件夹中",
      );
  }

  let parentDepth = 0;
  let parentCursor = move.parentId;

  while (parentCursor) {
    const parent = (
      await db
        .select({ parentId: tables.folders.parentId })
        .from(tables.folders)
        .where(ownedFolder(workspaceId, parentCursor))
        .limit(1)
    )[0];

    if (!parent) return fail(404, "NOT_FOUND", "目标文件夹不存在");
    parentDepth += 1;
    parentCursor = parent.parentId;
  }

  if (source.kind === "folder") {
    const levels = new Map([[source.id, 1]]);
    let deepest = 1;

    for (let pass = 0; pass < 5; pass += 1) {
      let added = false;

      for (const folder of subtreeFolders) {
        if (
          !folder.parentId ||
          !levels.has(folder.parentId) ||
          levels.has(folder.id)
        )
          continue;
        const depth = levels.get(folder.parentId)! + 1;

        levels.set(folder.id, depth);
        deepest = Math.max(deepest, depth);
        added = true;
      }

      if (!added) break;
    }

    if (parentDepth + deepest > 5)
      fail(400, "FOLDER_DEPTH_LIMIT", "移动后文件夹将超过五层限制");
  }

  if (move.parentId !== null) {
    const parent = await directoryItem(workspaceId, userId, {
      kind: "folder",
      id: move.parentId,
    });

    if (!parent || parent.kind !== "folder")
      return fail(404, "NOT_FOUND", "目标文件夹不存在");
  }

  if (move.placement !== "end" && !move.target)
    fail(400, "INVALID_DIRECTORY_MOVE", "移动位置缺少目标项目");
  if (
    move.target &&
    move.target.kind === move.source.kind &&
    move.target.id === move.source.id &&
    move.placement !== "end"
  )
    return { catalogRevision: move.catalogRevision };

  const targetRef = move.target;
  const target = targetRef
    ? await directoryItem(workspaceId, userId, targetRef)
    : null;

  if (targetRef && !target) return fail(404, "NOT_FOUND", "移动目标不存在");
  if (target && target.parentId !== move.parentId)
    return fail(400, "INVALID_DIRECTORY_MOVE", "移动目标不在指定目录中");
  const parentAvailable =
    move.parentId === null
      ? undefined
      : sql`EXISTS (SELECT 1 FROM folders WHERE id = ${move.parentId}
      AND workspace_id = ${workspaceId} AND deleted_at IS NULL)`;
  const targetAvailable = targetRef
    ? sql`EXISTS (SELECT 1 FROM ${sql.raw(targetRef.kind === "folder" ? "folders" : "canvases")}
      WHERE id = ${targetRef.id} AND workspace_id = ${workspaceId}
      AND parent_id IS ${move.parentId} AND deleted_at IS NULL)`
    : undefined;
  const sourceTable =
    move.source.kind === "folder" ? tables.folders : tables.canvases;
  const siblingParents = [...new Set([source.parentId, move.parentId])];
  const parentIds = siblingParents.filter((id): id is string => id !== null);
  const [folderRows, canvasRows] = await db.batch([
    db
      .select({
        id: tables.folders.id,
        parentId: tables.folders.parentId,
        position: tables.folders.position,
      })
      .from(tables.folders)
      .where(
        and(
          eq(tables.folders.workspaceId, workspaceId),
          or(
            siblingParents.includes(null)
              ? isNull(tables.folders.parentId)
              : undefined,
            parentIds.length
              ? inArray(tables.folders.parentId, parentIds)
              : undefined,
          ),
          isNull(tables.folders.deletedAt),
        ),
      ),
    db
      .select({
        id: tables.canvases.id,
        parentId: tables.canvases.parentId,
        position: tables.canvases.position,
      })
      .from(tables.canvases)
      .where(
        and(
          eq(tables.canvases.workspaceId, workspaceId),
          or(
            siblingParents.includes(null)
              ? isNull(tables.canvases.parentId)
              : undefined,
            parentIds.length
              ? inArray(tables.canvases.parentId, parentIds)
              : undefined,
          ),
          isNull(tables.canvases.deletedAt),
        ),
      ),
  ]);
  const siblings = [
    ...folderRows.map((row) => ({ ...row, kind: "folder" as const })),
    ...canvasRows.map((row) => ({ ...row, kind: "canvas" as const })),
  ];
  const sameNode = (a: { kind: string; id: string }, b: NodeRef) =>
    a.kind === b.kind && a.id === b.id;
  const sourceIndex = siblings.findIndex((row) => sameNode(row, move.source));

  if (sourceIndex < 0) return null;
  const sourceSibling = siblings[sourceIndex]!;
  const destination = siblings
    .filter(
      (row) => row.parentId === move.parentId && !sameNode(row, move.source),
    )
    .sort(
      (a, b) =>
        a.position - b.position ||
        binaryCompare(a.id, b.id) ||
        binaryCompare(a.kind, b.kind),
    );
  let finalPosition = destination.length;

  if (targetRef && target) {
    const targetIndex = destination.findIndex((row) =>
      sameNode(row, targetRef),
    );

    if (targetIndex < 0) return fail(404, "NOT_FOUND", "移动目标不存在");
    finalPosition = targetIndex + (move.placement === "after" ? 1 : 0);
    destination.splice(finalPosition, 0, sourceSibling);
  } else {
    destination.push(sourceSibling);
  }

  const destinationPositions = destination.map((row, position) => ({
    ...row,
    nextPosition: position,
  }));
  const oldPositions =
    source.parentId === move.parentId
      ? []
      : siblings
          .filter(
            (row) =>
              row.parentId === source.parentId && !sameNode(row, move.source),
          )
          .sort(
            (a, b) =>
              a.position - b.position ||
              binaryCompare(a.id, b.id) ||
              binaryCompare(a.kind, b.kind),
          )
          .map((row, position) => ({ ...row, nextPosition: position }));
  const maximumPosition = siblings.reduce(
    (maximum, row) => Math.max(maximum, row.position),
    -1,
  );
  const temporaryPosition = maximumPosition + 1;
  const sourceTableName =
    move.source.kind === "folder" ? "folders" : "canvases";
  const moveSource = db
    .update(sourceTable)
    .set({
      parentId: move.parentId,
      position: temporaryPosition,
    })
    .where(
      and(
        eq(sourceTable.id, move.source.id),
        eq(sourceTable.workspaceId, workspaceId),
        isNull(sourceTable.deletedAt),
        sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${workspaceId}
      AND user_id = ${userId} AND catalog_revision = ${move.catalogRevision}
      AND deleting = 0 AND deleted_at IS NULL)`,
        parentAvailable,
        targetAvailable,
      ),
    );
  const moveCompleted = sql`EXISTS (SELECT 1 FROM ${sql.raw(sourceTableName)}
    WHERE id = ${move.source.id} AND workspace_id = ${workspaceId}
      AND parent_id IS ${move.parentId} AND position = ${temporaryPosition}
      AND deleted_at IS NULL)`;
  const validWorkspace = sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${workspaceId}
    AND user_id = ${userId} AND catalog_revision = ${move.catalogRevision}
    AND deleting = 0 AND deleted_at IS NULL)`;
  const applyMap = (
    table: typeof tables.folders | typeof tables.canvases,
    kind: "folder" | "canvas",
    parent: string | null,
    mapping: typeof destinationPositions,
  ) => {
    const cases = mapping
      .filter((row) => row.kind === kind && !sameNode(row, move.source))
      .map(
        (row) =>
          `WHEN '${row.id.replace(/'/g, "''")}' THEN ${row.nextPosition}`,
      )
      .join(" ");

    return db
      .update(table)
      .set({
        position: cases
          ? sql.raw(`CASE "id" ${cases} ELSE "position" END`)
          : sql.raw('"position"'),
      })
      .where(
        and(
          eq(table.workspaceId, workspaceId),
          parent === null ? isNull(table.parentId) : eq(table.parentId, parent),
          isNull(table.deletedAt),
          validWorkspace,
          moveCompleted,
        ),
      );
  };
  const result = await db.batch([
    moveSource,
    applyMap(tables.folders, "folder", source.parentId, oldPositions),
    applyMap(tables.canvases, "canvas", source.parentId, oldPositions),
    applyMap(tables.folders, "folder", move.parentId, destinationPositions),
    applyMap(tables.canvases, "canvas", move.parentId, destinationPositions),
    db
      .update(tables.workspaces)
      .set({ catalogRevision: sql`${tables.workspaces.catalogRevision} + 1` })
      .where(
        and(
          ownerWorkspace(workspaceId, userId),
          eq(tables.workspaces.catalogRevision, move.catalogRevision),
          parentAvailable,
          targetAvailable,
          moveCompleted,
        ),
      )
      .returning({ catalogRevision: tables.workspaces.catalogRevision }),
    db
      .update(sourceTable)
      .set({ position: finalPosition })
      .where(
        and(
          eq(sourceTable.id, move.source.id),
          eq(sourceTable.workspaceId, workspaceId),
          isNull(sourceTable.deletedAt),
          move.parentId === null
            ? isNull(sourceTable.parentId)
            : eq(sourceTable.parentId, move.parentId),
          eq(sourceTable.position, temporaryPosition),
          sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${workspaceId}
        AND user_id = ${userId} AND catalog_revision = ${move.catalogRevision + 1}
        AND deleting = 0 AND deleted_at IS NULL)`,
        ),
      )
      .returning({ id: sourceTable.id }),
  ]);

  return result[5].length && result[6].length
    ? { catalogRevision: result[5][0]!.catalogRevision }
    : null;
}

export async function renameDirectoryFolder(
  id: string,
  userId: string,
  name: string,
  catalogRevision: number,
) {
  const location = await ownedFolderLocation(id, userId);

  if (!location) return null;
  const results = await db.batch([
    db
      .update(tables.folders)
      .set({ name, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(tables.folders.id, id),
          eq(tables.folders.workspaceId, location.workspaceId),
          isNull(tables.folders.deletedAt),
          sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${location.workspaceId}
          AND user_id = ${userId} AND catalog_revision = ${catalogRevision}
          AND deleting = 0 AND deleted_at IS NULL)`,
        ),
      ),
    db
      .update(tables.workspaces)
      .set({ catalogRevision: sql`${tables.workspaces.catalogRevision} + 1` })
      .where(
        and(
          ownerWorkspace(location.workspaceId, userId),
          eq(tables.workspaces.catalogRevision, catalogRevision),
          sql`EXISTS (SELECT 1 FROM folders WHERE id = ${id}
          AND workspace_id = ${location.workspaceId} AND deleted_at IS NULL)`,
        ),
      )
      .returning({ catalogRevision: tables.workspaces.catalogRevision }),
  ]);

  if (!results[1].length) return null;
  const item = await directoryItem(location.workspaceId, userId, {
    kind: "folder",
    id,
  });

  return item?.kind === "folder"
    ? { item, catalogRevision: results[1][0]!.catalogRevision }
    : null;
}

export async function setDirectoryFavorite(
  workspaceId: string,
  userId: string,
  source: NodeRef,
  favorite: boolean,
  catalogRevision: number,
) {
  const current = await directoryItem(workspaceId, userId, source);

  if (!current) return null;
  const currentWorkspace = (
    await db
      .select({ revision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(ownerWorkspace(workspaceId, userId))
      .limit(1)
  )[0];

  if (!currentWorkspace || currentWorkspace.revision !== catalogRevision)
    return null;
  if (current.favorite === favorite) return { item: current, catalogRevision };

  const activeSource =
    source.kind === "folder"
      ? sql`EXISTS (SELECT 1 FROM folders WHERE id = ${source.id} AND workspace_id = ${workspaceId} AND deleted_at IS NULL)`
      : sql`EXISTS (SELECT 1 FROM canvases WHERE id = ${source.id} AND workspace_id = ${workspaceId} AND deleted_at IS NULL)`;
  const tableQuery =
    source.kind === "folder"
      ? db
          .select({
            workspaceId: tables.workspaces.id,
            itemKind: sql<"folder">`'folder'`.as("itemKind"),
            itemId: tables.folders.id,
            position:
              sql<number>`COALESCE((SELECT MAX(position) + 1 FROM directory_favorites WHERE workspace_id = ${workspaceId}), 0)`.as(
                "position",
              ),
          })
          .from(tables.folders)
          .innerJoin(
            tables.workspaces,
            eq(tables.workspaces.id, tables.folders.workspaceId),
          )
          .where(
            and(
              eq(tables.folders.id, source.id),
              eq(tables.folders.workspaceId, workspaceId),
              isNull(tables.folders.deletedAt),
              eq(tables.workspaces.userId, userId),
              eq(tables.workspaces.deleting, 0),
              isNull(tables.workspaces.deletedAt),
              eq(tables.workspaces.catalogRevision, catalogRevision),
            ),
          )
      : db
          .select({
            workspaceId: tables.workspaces.id,
            itemKind: sql<"canvas">`'canvas'`.as("itemKind"),
            itemId: tables.canvases.id,
            position:
              sql<number>`COALESCE((SELECT MAX(position) + 1 FROM directory_favorites WHERE workspace_id = ${workspaceId}), 0)`.as(
                "position",
              ),
          })
          .from(tables.canvases)
          .innerJoin(
            tables.workspaces,
            eq(tables.workspaces.id, tables.canvases.workspaceId),
          )
          .where(
            and(
              eq(tables.canvases.id, source.id),
              eq(tables.canvases.workspaceId, workspaceId),
              isNull(tables.canvases.deletedAt),
              eq(tables.workspaces.userId, userId),
              eq(tables.workspaces.deleting, 0),
              isNull(tables.workspaces.deletedAt),
              eq(tables.workspaces.catalogRevision, catalogRevision),
            ),
          );
  const result = await db.batch([
    favorite
      ? db
          .insert(tables.directoryFavorites)
          .select(tableQuery)
          .onConflictDoNothing()
      : db.delete(tables.directoryFavorites).where(
          and(
            eq(tables.directoryFavorites.workspaceId, workspaceId),
            eq(tables.directoryFavorites.itemKind, source.kind),
            eq(tables.directoryFavorites.itemId, source.id),
            sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${workspaceId}
            AND user_id = ${userId} AND catalog_revision = ${catalogRevision}
            AND deleting = 0 AND deleted_at IS NULL)`,
            activeSource,
          ),
        ),

    source.kind === "canvas"
      ? db
          .update(tables.canvases)
          .set({ pinned: favorite })
          .where(
            and(
              eq(tables.canvases.id, source.id),
              eq(tables.canvases.workspaceId, workspaceId),
              isNull(tables.canvases.deletedAt),
              activeSource,
              sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${workspaceId}
            AND user_id = ${userId} AND catalog_revision = ${catalogRevision}
            AND deleting = 0 AND deleted_at IS NULL)`,
            ),
          )
      : db
          .select({ id: tables.folders.id })
          .from(tables.folders)
          .where(
            and(
              eq(tables.folders.id, source.id),
              eq(tables.folders.workspaceId, workspaceId),
              isNull(tables.folders.deletedAt),
              activeSource,
              sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${workspaceId}
            AND user_id = ${userId} AND catalog_revision = ${catalogRevision}
            AND deleting = 0 AND deleted_at IS NULL)`,
            ),
          )
          .limit(1),
    db
      .update(tables.workspaces)
      .set({ catalogRevision: sql`${tables.workspaces.catalogRevision} + 1` })
      .where(
        and(
          ownerWorkspace(workspaceId, userId),
          eq(tables.workspaces.catalogRevision, catalogRevision),
          activeSource,
        ),
      )
      .returning({ catalogRevision: tables.workspaces.catalogRevision }),
  ]);
  const nextRevision = result[2][0]?.catalogRevision;

  if (nextRevision === undefined) return null;
  const item = await directoryItem(workspaceId, userId, source);

  return item ? { item, catalogRevision: nextRevision } : null;
}

export async function directoryFavorites(workspaceId: string, userId: string) {
  const workspace = (
    await db
      .select({ catalogRevision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(ownerWorkspace(workspaceId, userId))
      .limit(1)
  )[0];

  if (!workspace) return null;
  const refs = await db
    .select({
      kind: tables.directoryFavorites.itemKind,
      id: tables.directoryFavorites.itemId,
    })
    .from(tables.directoryFavorites)
    .where(eq(tables.directoryFavorites.workspaceId, workspaceId))
    .orderBy(
      asc(tables.directoryFavorites.position),
      asc(tables.directoryFavorites.itemKind),
      asc(tables.directoryFavorites.itemId),
    );
  const items: DirectoryNode[] = [];

  for (const ref of refs) {
    const item = await directoryItem(workspaceId, userId, ref);

    if (item) items.push(item);
  }

  const currentRevision = (
    await db
      .select({ catalogRevision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(ownerWorkspace(workspaceId, userId))
      .limit(1)
  )[0]?.catalogRevision;

  if (currentRevision !== workspace.catalogRevision)
    fail(409, "CATALOG_CONFLICT", "收藏列表已更新，请重新加载");

  return { items, catalogRevision: workspace.catalogRevision };
}

export async function reorderDirectoryFavorites(
  workspaceId: string,
  userId: string,
  source: NodeRef,
  target: NodeRef,
  placement: "before" | "after",
  catalogRevision: number,
) {
  const workspace = (
    await db
      .select({ revision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(ownerWorkspace(workspaceId, userId))
      .limit(1)
  )[0];

  if (
    !workspace ||
    workspace.revision !== catalogRevision ||
    !(await directoryItem(workspaceId, userId, source)) ||
    !(await directoryItem(workspaceId, userId, target))
  )
    return null;
  const rows = await db
    .select({
      itemKind: tables.directoryFavorites.itemKind,
      itemId: tables.directoryFavorites.itemId,
      position: tables.directoryFavorites.position,
    })
    .from(tables.directoryFavorites)
    .where(
      and(
        eq(tables.directoryFavorites.workspaceId, workspaceId),
        or(
          and(
            eq(tables.directoryFavorites.itemKind, source.kind),
            eq(tables.directoryFavorites.itemId, source.id),
          ),
          and(
            eq(tables.directoryFavorites.itemKind, target.kind),
            eq(tables.directoryFavorites.itemId, target.id),
          ),
        ),
      ),
    );
  const sourceRow = rows.find(
    (row) => row.itemKind === source.kind && row.itemId === source.id,
  );
  const targetRow = rows.find(
    (row) => row.itemKind === target.kind && row.itemId === target.id,
  );

  if (!sourceRow || !targetRow) return null;
  const start = sourceRow.position;
  const end = targetRow.position;

  if (source.kind === target.kind && source.id === target.id)
    return { catalogRevision };
  if (start === end) return null;

  let destination: number;
  let range: ReturnType<typeof and>;
  let delta: number;

  if (placement === "before" && start > end) {
    destination = end;
    range = and(
      gte(tables.directoryFavorites.position, end),
      lt(tables.directoryFavorites.position, start),
    );
    delta = 1;
  } else if (placement === "before") {
    destination = end - 1;
    range = and(
      gt(tables.directoryFavorites.position, start),
      lt(tables.directoryFavorites.position, end),
    );
    delta = -1;
  } else if (start > end) {
    destination = end + 1;
    range = and(
      gt(tables.directoryFavorites.position, end),
      lt(tables.directoryFavorites.position, start),
    );
    delta = -1;
  } else {
    destination = end;
    range = and(
      gt(tables.directoryFavorites.position, start),
      lte(tables.directoryFavorites.position, end),
    );
    delta = 1;
  }

  const validWorkspace = sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${workspaceId}
    AND user_id = ${userId} AND catalog_revision = ${catalogRevision}
    AND deleting = 0 AND deleted_at IS NULL)`;
  const sourceFavorite = and(
    eq(tables.directoryFavorites.workspaceId, workspaceId),
    eq(tables.directoryFavorites.itemKind, source.kind),
    eq(tables.directoryFavorites.itemId, source.id),
    validWorkspace,
  );
  const targetFavorite = db
    .select({ id: tables.directoryFavorites.itemId })
    .from(tables.directoryFavorites)
    .where(
      and(
        eq(tables.directoryFavorites.workspaceId, workspaceId),
        eq(tables.directoryFavorites.itemKind, target.kind),
        eq(tables.directoryFavorites.itemId, target.id),
      ),
    );
  const results = await db.batch([
    db
      .update(tables.directoryFavorites)
      .set({ position: destination })
      .where(
        and(sourceFavorite, eq(tables.directoryFavorites.position, start)),
      ),
    db
      .update(tables.directoryFavorites)
      .set({
        position: sql`${tables.directoryFavorites.position} + ${delta}`,
      })
      .where(
        and(
          eq(tables.directoryFavorites.workspaceId, workspaceId),
          range,
          or(
            ne(tables.directoryFavorites.itemKind, source.kind),
            ne(tables.directoryFavorites.itemId, source.id),
          ),
          validWorkspace,
        ),
      ),
    db
      .update(tables.workspaces)
      .set({ catalogRevision: sql`${tables.workspaces.catalogRevision} + 1` })
      .where(
        and(
          ownerWorkspace(workspaceId, userId),
          eq(tables.workspaces.catalogRevision, catalogRevision),
          exists(targetFavorite),
        ),
      )
      .returning({ catalogRevision: tables.workspaces.catalogRevision }),
  ]);

  return results[2][0]
    ? { catalogRevision: results[2][0].catalogRevision }
    : null;
}

export async function directoryPage(
  workspaceId: string,
  userId: string,
  parentId: string | null,
  limit: number,
  cursorValue?: string,
): Promise<DirectoryPage> {
  const cursor = cursorValue
    ? decodeCursor(cursorValue, workspaceId, parentId)
    : undefined;
  const [spaceRows, folderCountRows, canvasCountRows] = await db.batch([
    db
      .select({ catalogRevision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(ownerWorkspace(workspaceId, userId)),
    db
      .select({ total: count() })
      .from(tables.folders)
      .where(
        and(
          eq(tables.folders.workspaceId, workspaceId),
          parentId === null
            ? isNull(tables.folders.parentId)
            : eq(tables.folders.parentId, parentId),
          isNull(tables.folders.deletedAt),
        ),
      ),
    db
      .select({ total: count() })
      .from(tables.canvases)
      .where(
        and(
          eq(tables.canvases.workspaceId, workspaceId),
          parentId === null
            ? isNull(tables.canvases.parentId)
            : eq(tables.canvases.parentId, parentId),
          isNull(tables.canvases.deletedAt),
        ),
      ),
  ]);
  const catalogRevision = spaceRows[0]?.catalogRevision;

  if (catalogRevision === undefined)
    return fail(404, "NOT_FOUND", "工作区不存在");
  if (cursor && cursor.catalogRevision !== catalogRevision)
    return fail(409, "CATALOG_CONFLICT", "目录已更新，请重新加载");
  if (
    parentId !== null &&
    !(
      await db
        .select({ id: tables.folders.id })
        .from(tables.folders)
        .where(ownedFolder(workspaceId, parentId))
        .limit(1)
    ).length
  )
    return fail(404, "NOT_FOUND", "文件夹不存在");

  const [folderRows, canvasRows] = await db.batch([
    db
      .select()
      .from(tables.folders)
      .where(
        and(
          eq(tables.folders.workspaceId, workspaceId),
          parentId === null
            ? isNull(tables.folders.parentId)
            : eq(tables.folders.parentId, parentId),
          isNull(tables.folders.deletedAt),
          cursorFilter(cursor),
        ),
      )
      .orderBy(asc(tables.folders.position), asc(tables.folders.id))
      .limit(limit + 1),
    db
      .select()
      .from(tables.canvases)
      .where(
        and(
          eq(tables.canvases.workspaceId, workspaceId),
          parentId === null
            ? isNull(tables.canvases.parentId)
            : eq(tables.canvases.parentId, parentId),
          isNull(tables.canvases.deletedAt),
          canvasCursorFilter(cursor),
        ),
      )
      .orderBy(asc(tables.canvases.position), asc(tables.canvases.id))
      .limit(limit + 1),
  ]);
  const candidates = [
    ...folderRows.map(mapFolder),
    ...canvasRows.map(mapCanvas),
  ].sort(sortNodes);
  const items = candidates.slice(0, limit);
  const last = items.at(-1);
  const resolved = await hydrateDirectoryNodes(workspaceId, items);
  const currentRevision = (
    await db
      .select({ catalogRevision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(ownerWorkspace(workspaceId, userId))
      .limit(1)
  )[0]?.catalogRevision;

  if (currentRevision === undefined)
    return fail(404, "NOT_FOUND", "工作区不存在");
  if (currentRevision !== catalogRevision)
    return fail(409, "CATALOG_CONFLICT", "目录已更新，请重新加载");

  return {
    parentId,
    items: resolved,
    total: folderCountRows[0]!.total + canvasCountRows[0]!.total,
    catalogRevision,
    nextCursor:
      candidates.length > limit && last
        ? encodeCursor({
            version: 1,
            workspaceId,
            parentId,
            catalogRevision,
            position: last.position,
            id: last.id,
            kind: last.kind,
          })
        : null,
  };
}
