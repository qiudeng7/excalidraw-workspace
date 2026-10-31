import { db } from "@nuxthub/db";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import * as tables from "#server/db/schema";
import type {
  BatchDirectorySummaryResponse,
  BatchDeleteDirectoryResponse,
  BatchMoveDirectoryRequest,
  BatchMoveDirectoryResponse,
  BatchUndoDirectoryRequest,
  BatchUndoDirectoryResponse,
  DeleteDirectoryUndoReceipt,
  MoveDirectoryUndoReceipt,
  MoveOrigin,
  NodeRef,
} from "#shared/directory-contracts";
import { ApiError } from "#server/utils/http";

const MAX_SOURCES = 100;
const RETENTION_MS = 30 * 86400000;
const failBatch = (message = "批量目录参数无效"): never => {
  throw new ApiError(400, "INVALID_DIRECTORY_BATCH", message);
};
const conflict = (
  code = "CATALOG_CONFLICT",
  message = "目录已更新，请重新加载",
): never => {
  throw new ApiError(409, code, message);
};
const notFound = (): never => {
  throw new ApiError(404, "NOT_FOUND", "目录项目不存在");
};
const invalidMove = (message: string): never => {
  throw new ApiError(400, "INVALID_DIRECTORY_MOVE", message);
};
const depthLimit = (): never => {
  throw new ApiError(400, "FOLDER_DEPTH_LIMIT", "文件夹最多嵌套五层");
};
const keyOf = (ref: NodeRef) => `${ref.kind}:${ref.id}`;
const binaryCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const json = (value: unknown) => JSON.stringify(value);

interface ActiveRow {
  ref: NodeRef;
  parentId: string | null;
  position: number;
}

interface FolderRow extends ActiveRow {
  ref: { kind: "folder"; id: string };
}

interface CanvasRow extends ActiveRow {
  ref: { kind: "canvas"; id: string };
}

const sourceJson = (refs: NodeRef[]) =>
  json(refs.map(({ kind, id }) => ({ kind, id })));
const parentJson = (parents: (string | null)[]) =>
  json(parents.map((id) => ({ id })));
const rowsetRefs = (column: SQLWrapper, kind: NodeRef["kind"], value: string) =>
  sql`${column} IN (
    SELECT json_extract(value, '$.id') FROM json_each(${value})
    WHERE json_extract(value, '$.kind') = ${kind}
  )`;
const rowsetParents = (column: SQLWrapper, parents: (string | null)[]) => {
  const nonNull = parents.filter((parent): parent is string => parent !== null);
  const clauses = [];

  if (nonNull.length)
    clauses.push(sql`${column} IN (
      SELECT json_extract(value, '$.id') FROM json_each(${parentJson(nonNull)})
    )`);
  if (parents.includes(null)) clauses.push(isNull(column));

  return or(...clauses);
};

const activeWorkspace = (workspaceId: string, userId: string) =>
  and(
    eq(tables.workspaces.id, workspaceId),
    eq(tables.workspaces.userId, userId),
    eq(tables.workspaces.deleting, 0),
    isNull(tables.workspaces.deletedAt),
  );
const workspaceAtRevision = (
  workspaceId: string,
  userId: string,
  revision: number,
) =>
  sql`EXISTS (
    SELECT 1 FROM workspaces
    WHERE id = ${workspaceId} AND user_id = ${userId}
      AND deleting = 0 AND deleted_at IS NULL
      AND catalog_revision = ${revision}
  )`;

const fetchSources = async (
  workspaceId: string,
  refs: NodeRef[],
): Promise<ActiveRow[]> => {
  const refsJson = sourceJson(refs);
  const [folders, canvases] = await db.batch([
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
          isNull(tables.folders.deletedAt),
          rowsetRefs(tables.folders.id, "folder", refsJson),
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
          isNull(tables.canvases.deletedAt),
          rowsetRefs(tables.canvases.id, "canvas", refsJson),
        ),
      ),
  ]);

  return [
    ...folders.map((row): FolderRow => ({
      ...row,
      ref: { kind: "folder", id: row.id },
    })),
    ...canvases.map((row): CanvasRow => ({
      ...row,
      ref: { kind: "canvas", id: row.id },
    })),
  ];
};

const fetchFoldersByIds = async (workspaceId: string, ids: string[]) => {
  if (!ids.length) return [];
  const idJson = json(ids.map((id) => ({ id })));

  return db
    .select({ id: tables.folders.id, parentId: tables.folders.parentId })
    .from(tables.folders)
    .where(
      and(
        eq(tables.folders.workspaceId, workspaceId),
        isNull(tables.folders.deletedAt),
        sql`${tables.folders.id} IN (SELECT json_extract(value, '$.id') FROM json_each(${idJson}))`,
      ),
    );
};

const ancestorChains = async (workspaceId: string, sources: ActiveRow[]) => {
  const parents = new Map<string, Set<string>>();
  const parentById = new Map<string, string | null>();
  const chains = sources.map((source) => ({
    current: source.parentId,
    depth: 0,
    visited: new Set<string>(),
  }));

  while (chains.some((chain) => chain.current !== null)) {
    const currentChains = chains.filter(
      (chain): chain is typeof chain & { current: string } =>
        chain.current !== null,
    );
    const frontier = new Set<string>();

    for (const chain of currentChains) {
      if (chain.visited.has(chain.current))
        conflict("INVALID_DIRECTORY_BATCH", "目录层级存在循环");
      if (chain.depth >= 5)
        conflict("INVALID_DIRECTORY_BATCH", "文件夹最多嵌套五层");
      chain.visited.add(chain.current);
      frontier.add(chain.current);
    }

    const missing = [...frontier].filter((id) => !parentById.has(id));
    const rows = await fetchFoldersByIds(workspaceId, missing);

    if (rows.length !== missing.length) notFound();
    for (const row of rows) parentById.set(row.id, row.parentId);
    for (const id of frontier) {
      const parentId = parentById.get(id)!;

      parents.set(id, new Set(parentId ? [parentId] : []));
    }

    for (const chain of currentChains) {
      chain.current = parentById.get(chain.current)!;
      chain.depth += 1;
    }
  }

  return parents;
};

const normalizeSources = async (workspaceId: string, refs: NodeRef[]) => {
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_SOURCES)
    failBatch();
  const seen = new Set<string>();

  for (const ref of refs) {
    if (
      !ref ||
      (ref.kind !== "folder" && ref.kind !== "canvas") ||
      typeof ref.id !== "string" ||
      !ref.id ||
      seen.has(keyOf(ref))
    )
      failBatch();
    seen.add(keyOf(ref));
  }

  const rows = await fetchSources(workspaceId, refs);
  const byKey = new Map(rows.map((row) => [keyOf(row.ref), row]));

  if (byKey.size !== refs.length) notFound();
  const ancestors = await ancestorChains(workspaceId, rows);
  const selectedFolders = new Set(
    refs.filter((ref) => ref.kind === "folder").map((ref) => ref.id),
  );
  const covered = (parentId: string | null) => {
    let current = parentId;
    const traversed = new Set<string>();

    while (current) {
      if (traversed.has(current))
        conflict("INVALID_DIRECTORY_BATCH", "目录层级存在循环");
      traversed.add(current);
      if (selectedFolders.has(current)) return true;
      current = ancestors.get(current)?.values().next().value ?? null;
    }

    return false;
  };
  const normalized = refs.filter((ref) => {
    const row = byKey.get(keyOf(ref))!;

    return !covered(row.parentId);
  });

  return { normalized, rows: normalized.map((ref) => byKey.get(keyOf(ref))!) };
};

const subtreeFolders = async (workspaceId: string, roots: NodeRef[]) => {
  const folderRoots = roots.filter((ref) => ref.kind === "folder");

  if (!folderRoots.length) return [];
  const refsJson = sourceJson(folderRoots);

  return db
    .select({
      id: tables.folders.id,
      parentId: tables.folders.parentId,
      position: tables.folders.position,
    })
    .from(tables.folders)
    .where(
      and(
        eq(tables.folders.workspaceId, workspaceId),
        isNull(tables.folders.deletedAt),
        sql`${tables.folders.id} IN (
      WITH RECURSIVE tree(id) AS (
        SELECT json_extract(value, '$.id') FROM json_each(${refsJson})
        UNION
        SELECT child.id FROM folders child JOIN tree ON child.parent_id = tree.id
        WHERE child.workspace_id = ${workspaceId} AND child.deleted_at IS NULL
      ) SELECT id FROM tree
    )`,
      ),
    );
};

const subtreeCanvases = async (workspaceId: string, roots: NodeRef[]) => {
  const folderRoots = roots.filter((ref) => ref.kind === "folder");
  const canvasRoots = roots.filter((ref) => ref.kind === "canvas");
  const folderRefs = sourceJson(folderRoots);
  const canvasRefs = sourceJson(canvasRoots);

  return db
    .select({
      id: tables.canvases.id,
      parentId: tables.canvases.parentId,
      position: tables.canvases.position,
    })
    .from(tables.canvases)
    .where(
      and(
        eq(tables.canvases.workspaceId, workspaceId),
        isNull(tables.canvases.deletedAt),
        or(
          canvasRoots.length
            ? rowsetRefs(tables.canvases.id, "canvas", canvasRefs)
            : undefined,
          folderRoots.length
            ? sql`${tables.canvases.parentId} IN (
        WITH RECURSIVE tree(id) AS (
          SELECT json_extract(value, '$.id') FROM json_each(${folderRefs})
          UNION
          SELECT child.id FROM folders child JOIN tree ON child.parent_id = tree.id
          WHERE child.workspace_id = ${workspaceId} AND child.deleted_at IS NULL
        ) SELECT id FROM tree
      )`
            : undefined,
        ),
      ),
    );
};

const loadSiblings = async (
  workspaceId: string,
  parents: (string | null)[],
): Promise<ActiveRow[]> => {
  const filterFolders = rowsetParents(tables.folders.parentId, parents);
  const filterCanvases = rowsetParents(tables.canvases.parentId, parents);
  const [folders, canvases] = await db.batch([
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
          isNull(tables.folders.deletedAt),
          filterFolders,
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
          isNull(tables.canvases.deletedAt),
          filterCanvases,
        ),
      ),
  ]);

  return [
    ...folders.map((row): FolderRow => ({
      ...row,
      ref: { kind: "folder", id: row.id },
    })),
    ...canvases.map((row): CanvasRow => ({
      ...row,
      ref: { kind: "canvas", id: row.id },
    })),
  ].sort(
    (a, b) =>
      a.position - b.position ||
      binaryCompare(a.ref.id, b.ref.id) ||
      binaryCompare(a.ref.kind, b.ref.kind),
  );
};

const validParentDepth = async (
  workspaceId: string,
  parentId: string | null,
) => {
  const visited = new Set<string>();
  let current = parentId;
  let depth = 0;

  while (current) {
    if (visited.has(current)) invalidMove("目标目录存在循环");
    if (depth >= 5) depthLimit();
    visited.add(current);
    const row = (await fetchFoldersByIds(workspaceId, [current]))[0];

    if (!row) return notFound();
    depth += 1;
    current = row.parentId;
  }

  if (depth > 5) depthLimit();

  return depth;
};

const depthByFolderId = (
  folders: Awaited<ReturnType<typeof subtreeFolders>>,
  rootId: string,
  onCycle: () => never = () =>
    conflict("INVALID_DIRECTORY_BATCH", "文件夹层级存在循环"),
) => {
  const parentById = new Map(
    folders.map((folder) => [folder.id, folder.parentId]),
  );
  const depths = new Map([[rootId, 1]]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (
        folder.parentId &&
        depths.has(folder.parentId) &&
        !depths.has(folder.id)
      ) {
        depths.set(folder.id, depths.get(folder.parentId)! + 1);
        changed = true;
      }
    }
  }

  if (
    depths.size !==
    folders.filter((folder) => {
      let current: string | null = folder.id;
      const seen = new Set<string>();

      while (current && !seen.has(current)) {
        if (current === rootId) return true;
        seen.add(current);
        current = parentById.get(current) ?? null;
      }

      return false;
    }).length
  )
    onCycle();

  return [...depths.values()].reduce(
    (maximum, depth) => Math.max(maximum, depth),
    1,
  );
};

const folderIsWithin = (
  folders: Awaited<ReturnType<typeof subtreeFolders>>,
  id: string,
  rootId: string,
  onCycle: () => never = () => invalidMove("目录层级存在循环"),
) => {
  const parentById = new Map(
    folders.map((folder) => [folder.id, folder.parentId]),
  );
  let current = id;
  const seen = new Set<string>();

  while (current) {
    if (seen.has(current)) onCycle();
    if (current === rootId) return true;
    seen.add(current);
    current = parentById.get(current) ?? "";
  }

  return false;
};

const mappingJson = (
  rows: Array<{ ref: NodeRef; parentId: string | null; position: number }>,
) =>
  json(
    rows.map((row) => ({
      ...row.ref,
      parentId: row.parentId,
      position: row.position,
    })),
  );
const mappedPosition = (
  table: { id: SQLWrapper },
  kind: NodeRef["kind"],
  mapping: string,
) =>
  sql`CAST((SELECT json_extract(value, '$.position') FROM json_each(${mapping})
    WHERE json_extract(value, '$.kind') = ${kind}
      AND json_extract(value, '$.id') = ${table.id}) AS INTEGER)`;
const mappedParent = (
  table: { id: SQLWrapper },
  kind: NodeRef["kind"],
  mapping: string,
) =>
  sql`(SELECT json_extract(value, '$.parentId') FROM json_each(${mapping})
    WHERE json_extract(value, '$.kind') = ${kind}
      AND json_extract(value, '$.id') = ${table.id})`;
const mappedIds = (
  table: { id: SQLWrapper },
  mapping: string,
  kind: NodeRef["kind"],
) =>
  sql`${table.id} IN (SELECT json_extract(value, '$.id') FROM json_each(${mapping}) WHERE json_extract(value, '$.kind') = ${kind})`;

export async function summarizeDirectorySelection(
  workspaceId: string,
  userId: string,
  sources: NodeRef[],
  catalogRevision: number,
): Promise<BatchDirectorySummaryResponse | null> {
  const workspace = (
    await db
      .select({ revision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(activeWorkspace(workspaceId, userId))
      .limit(1)
  )[0];

  if (!workspace) return null;
  if (workspace.revision !== catalogRevision) conflict();
  const { normalized } = await normalizeSources(workspaceId, sources);
  const [folders, canvases] = await Promise.all([
    subtreeFolders(workspaceId, normalized),
    subtreeCanvases(workspaceId, normalized),
  ]);
  const current = (
    await db
      .select({ revision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(activeWorkspace(workspaceId, userId))
      .limit(1)
  )[0]?.revision;

  if (current === undefined) return null;
  if (current !== catalogRevision) conflict();

  return {
    normalizedSources: normalized,
    folderCount: folders.length,
    canvasCount: canvases.length,
    catalogRevision,
  };
}

export async function moveDirectorySelection(
  workspaceId: string,
  userId: string,
  request: BatchMoveDirectoryRequest,
): Promise<BatchMoveDirectoryResponse | null> {
  const workspace = (
    await db
      .select({ revision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(activeWorkspace(workspaceId, userId))
      .limit(1)
  )[0];

  if (!workspace) return null;
  if (workspace.revision !== request.catalogRevision) conflict();
  const { normalized, rows: sourceRows } = await normalizeSources(
    workspaceId,
    request.sources,
  );

  if (
    request.placement === "end" ? request.target !== undefined : !request.target
  )
    failBatch();
  const targetParentDepth = await validParentDepth(
    workspaceId,
    request.parentId,
  );
  const targetParent = request.parentId
    ? (await fetchFoldersByIds(workspaceId, [request.parentId]))[0]
    : undefined;

  if (request.parentId && !targetParent) notFound();
  const folders = await subtreeFolders(workspaceId, normalized);

  for (const source of normalized.filter((ref) => ref.kind === "folder")) {
    if (
      request.parentId &&
      folderIsWithin(folders, request.parentId, source.id)
    )
      invalidMove("不能移动到自身或子文件夹");
    const depth = depthByFolderId(folders, source.id);

    if (targetParentDepth + depth > 5) depthLimit();
  }

  const parents = [
    ...new Set([...sourceRows.map((row) => row.parentId), request.parentId]),
  ];
  const siblings = await loadSiblings(workspaceId, parents);
  const selected = new Set(normalized.map(keyOf));
  const origins: MoveOrigin[] = sourceRows.map((row) => ({
    source: row.ref,
    parentId: row.parentId,
    index: siblings
      .filter((sibling) => sibling.parentId === row.parentId)
      .findIndex((sibling) => keyOf(sibling.ref) === keyOf(row.ref)),
  }));

  if (origins.some((origin) => origin.index < 0)) conflict();
  if (request.target && selected.has(keyOf(request.target)))
    invalidMove("移动目标不能是所选项目");
  const target = request.target
    ? (await fetchSources(workspaceId, [request.target]))[0]
    : undefined;

  if (request.target && !target) notFound();
  if (target && target.parentId !== request.parentId)
    invalidMove("移动目标不是目标目录的直接子项目");
  const targetSiblings = siblings.filter(
    (row) => row.parentId === request.parentId && !selected.has(keyOf(row.ref)),
  );
  const block = normalized.map((ref) =>
    sourceRows.find((row) => keyOf(row.ref) === keyOf(ref))!,
  );
  let insertAt = targetSiblings.length;

  if (target) {
    const index = targetSiblings.findIndex(
      (row) => keyOf(row.ref) === keyOf(target.ref),
    );

    if (index < 0) notFound();
    insertAt = index + (request.placement === "after" ? 1 : 0);
  }

  targetSiblings.splice(insertAt, 0, ...block);
  const finalRows: Array<{
    ref: NodeRef;
    parentId: string | null;
    position: number;
  }> = [];

  for (const parentId of parents) {
    const ordered =
      parentId === request.parentId
        ? targetSiblings
        : siblings.filter(
            (row) => row.parentId === parentId && !selected.has(keyOf(row.ref)),
          );

    ordered.forEach((row, position) =>
      finalRows.push({ ref: row.ref, parentId, position }),
    );
  }

  const changed = parents.some((parentId) => {
    const currentOrder = siblings
      .filter((row) => row.parentId === parentId)
      .map((row) => keyOf(row.ref));
    const nextOrder = finalRows
      .filter((row) => row.parentId === parentId)
      .map((row) => keyOf(row.ref));

    return (
      currentOrder.some((key, index) => key !== nextOrder[index]) ||
      currentOrder.length !== nextOrder.length
    );
  });

  if (!changed)
    return {
      changed: false,
      catalogRevision: request.catalogRevision,
      normalizedSources: normalized,
      undo: null,
    };
  const mapping = mappingJson(finalRows);
  const revisionGuard = workspaceAtRevision(
    workspaceId,
    userId,
    request.catalogRevision,
  );
  const result = await db.batch([
    db
      .update(tables.folders)
      .set({
        parentId: mappedParent(tables.folders, "folder", mapping),
        position: mappedPosition(tables.folders, "folder", mapping),
      })
      .where(
        and(
          eq(tables.folders.workspaceId, workspaceId),
          isNull(tables.folders.deletedAt),
          mappedIds(tables.folders, mapping, "folder"),
          revisionGuard,
        ),
      ),
    db
      .update(tables.canvases)
      .set({
        parentId: mappedParent(tables.canvases, "canvas", mapping),
        position: mappedPosition(tables.canvases, "canvas", mapping),
      })
      .where(
        and(
          eq(tables.canvases.workspaceId, workspaceId),
          isNull(tables.canvases.deletedAt),
          mappedIds(tables.canvases, mapping, "canvas"),
          revisionGuard,
        ),
      ),
    db
      .update(tables.workspaces)
      .set({ catalogRevision: sql`${tables.workspaces.catalogRevision} + 1` })
      .where(
        and(
          activeWorkspace(workspaceId, userId),
          eq(tables.workspaces.catalogRevision, request.catalogRevision),
        ),
      )
      .returning({ catalogRevision: tables.workspaces.catalogRevision }),
  ]);
  const nextRevision = result[2][0]?.catalogRevision;

  if (nextRevision === undefined) return conflict();

  return {
    changed: true,
    catalogRevision: nextRevision,
    normalizedSources: normalized,
    undo: {
      kind: "move",
      expectedCatalogRevision: nextRevision,
      destinationParentId: request.parentId,
      origins,
    },
  };
}

const mappedDeleteBatchId = (
  table: { id: SQLWrapper },
  mapping: string,
) => sql`(SELECT json_extract(value, '$.deleteBatchId') FROM json_each(${mapping})
  WHERE json_extract(value, '$.id') = ${table.id})`;
const mappedRowIds = (table: { id: SQLWrapper }, mapping: string) =>
  sql`${table.id} IN (SELECT json_extract(value, '$.id') FROM json_each(${mapping}))`;

export async function deleteDirectorySelection(
  workspaceId: string,
  userId: string,
  sources: NodeRef[],
  catalogRevision: number,
  now = new Date().toISOString(),
): Promise<BatchDeleteDirectoryResponse | null> {
  const workspace = (
    await db
      .select({ revision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(activeWorkspace(workspaceId, userId))
      .limit(1)
  )[0];

  if (!workspace) return null;
  if (workspace.revision !== catalogRevision) conflict();
  const { normalized } = await normalizeSources(workspaceId, sources);
  const [folders, canvases] = await Promise.all([
    subtreeFolders(workspaceId, normalized),
    subtreeCanvases(workspaceId, normalized),
  ]);
  const folderRoots = normalized
    .filter((ref) => ref.kind === "folder")
    .map((root) => ({ id: root.id, deleteBatchId: crypto.randomUUID() }));
  const batchByRoot = new Map(
    folderRoots.map((root) => [root.id, root.deleteBatchId]),
  );
  const batchByFolder = new Map(batchByRoot);
  let assigned = true;

  while (assigned) {
    assigned = false;
    for (const folder of folders) {
      const batchId = folder.parentId
        ? batchByFolder.get(folder.parentId)
        : undefined;

      if (batchId && !batchByFolder.has(folder.id)) {
        batchByFolder.set(folder.id, batchId);
        assigned = true;
      }
    }
  }

  if (batchByFolder.size !== folders.length && folders.length)
    conflict("INVALID_DIRECTORY_BATCH", "文件夹层级存在循环");
  const folderChanges = folders.map((folder) => ({
    id: folder.id,
    deleteBatchId: batchByFolder.get(folder.id)!,
  }));
  const directCanvasIds = new Set(
    normalized.filter((ref) => ref.kind === "canvas").map((ref) => ref.id),
  );
  const canvasChanges = canvases.map((canvas) => ({
    id: canvas.id,
    deleteBatchId: directCanvasIds.has(canvas.id)
      ? null
      : (batchByFolder.get(canvas.parentId ?? "") ?? null),
  }));

  if (
    canvasChanges.some(
      (canvas) =>
        canvas.deleteBatchId === null && !directCanvasIds.has(canvas.id),
    )
  )
    conflict("INVALID_DIRECTORY_BATCH", "画布不属于所选目录树");
  const folderChangesJson = json(folderChanges);
  const canvasChangesJson = json(canvasChanges);
  const affectedCanvasSet = new Set(canvases.map((row) => row.id));
  const canvasIdsJson = json([...affectedCanvasSet].map((id) => ({ id })));
  const valid = workspaceAtRevision(workspaceId, userId, catalogRevision);
  const result = await db.batch([
    db
      .update(tables.folders)
      .set({
        deletedAt: now,
        deleteBatchId: mappedDeleteBatchId(tables.folders, folderChangesJson),
      })
      .where(
        and(
          eq(tables.folders.workspaceId, workspaceId),
          isNull(tables.folders.deletedAt),
          mappedRowIds(tables.folders, folderChangesJson),
          valid,
        ),
      )
      .returning({ id: tables.folders.id }),
    db
      .update(tables.canvases)
      .set({
        deletedAt: now,
        deleteBatchId: mappedDeleteBatchId(tables.canvases, canvasChangesJson),
        revision: sql`${tables.canvases.revision} + 1`,
        recycleRevision: sql`${tables.canvases.recycleRevision} + 1`,
        recyclePending: 1,
      })
      .where(
        and(
          eq(tables.canvases.workspaceId, workspaceId),
          isNull(tables.canvases.deletedAt),
          mappedRowIds(tables.canvases, canvasChangesJson),
          valid,
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
          sql`${tables.userNavigation.lastCanvasId} IN (SELECT json_extract(value, '$.id') FROM json_each(${canvasIdsJson}))`,
          valid,
        ),
      ),
    db
      .update(tables.workspaceNavigation)
      .set({ lastCanvasId: null })
      .where(
        and(
          eq(tables.workspaceNavigation.userId, userId),
          eq(tables.workspaceNavigation.workspaceId, workspaceId),
          sql`${tables.workspaceNavigation.lastCanvasId} IN (SELECT json_extract(value, '$.id') FROM json_each(${canvasIdsJson}))`,
          valid,
        ),
      ),
    db
      .delete(tables.canvasSessions)
      .where(
        and(
          sql`${tables.canvasSessions.canvasId} IN (SELECT json_extract(value, '$.id') FROM json_each(${canvasIdsJson}))`,
          valid,
        ),
      ),
    db
      .update(tables.workspaces)
      .set({ catalogRevision: sql`${tables.workspaces.catalogRevision} + 1` })
      .where(
        and(
          activeWorkspace(workspaceId, userId),
          eq(tables.workspaces.catalogRevision, catalogRevision),
        ),
      )
      .returning({ catalogRevision: tables.workspaces.catalogRevision }),
  ]);
  const nextRevision = result[5][0]?.catalogRevision;

  if (nextRevision === undefined) return conflict();

  return {
    catalogRevision: nextRevision,
    normalizedSources: normalized,
    receipt: {
      kind: "delete",
      expectedCatalogRevision: nextRevision,
      roots: normalized.map((root) => ({
        root,
        deleteBatchId:
          root.kind === "folder"
            ? folderRoots.find((item) => item.id === root.id)!.deleteBatchId
            : null,
      })),
    },
    affectedFolderIds: folders.map((row) => row.id),
    affectedCanvasIds: canvases.map((row) => row.id),
  };
}

const receiptFolders = async (workspaceId: string, batchIds: string[]) => {
  if (!batchIds.length) return [];
  const values = json(batchIds.map((deleteBatchId) => ({ deleteBatchId })));

  return db
    .select()
    .from(tables.folders)
    .where(
      and(
        eq(tables.folders.workspaceId, workspaceId),
        sql`${tables.folders.deleteBatchId} IN (
      SELECT json_extract(value, '$.deleteBatchId') FROM json_each(${values})
    )`,
      ),
    );
};

const requireActiveParent = async (
  workspaceId: string,
  parentId: string | null,
) => {
  if (parentId === null) return 0;
  const visited = new Set<string>();
  let current: string | null = parentId;
  let depth = 0;

  while (current) {
    if (visited.has(current))
      conflict("DIRECTORY_UNDO_CONFLICT", "恢复位置存在循环");
    if (depth >= 5)
      conflict("RESTORE_LOCATION_REQUIRED", "恢复位置超过五层限制");
    visited.add(current);
    const parentRow: { id: string; parentId: string | null } | undefined = (
      await fetchFoldersByIds(workspaceId, [current])
    )[0];

    if (!parentRow)
      return conflict(
        "RESTORE_LOCATION_REQUIRED",
        "原文件夹已不可用，请在回收站选择其他操作",
      );
    depth += 1;
    current = parentRow.parentId;
  }

  return depth;
};

const moveReceipt = (value: unknown): value is MoveDirectoryUndoReceipt => {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;

  if (
    receipt.kind !== "move" ||
    !Number.isSafeInteger(receipt.expectedCatalogRevision) ||
    (receipt.expectedCatalogRevision as number) < 0 ||
    (receipt.destinationParentId !== null &&
      typeof receipt.destinationParentId !== "string") ||
    !Array.isArray(receipt.origins) ||
    !receipt.origins.length ||
    receipt.origins.length > MAX_SOURCES
  )
    return false;

  return receipt.origins.every(
    (origin) =>
      !!origin &&
      typeof origin === "object" &&
      !!(origin as MoveOrigin).source &&
      ["folder", "canvas"].includes((origin as MoveOrigin).source.kind) &&
      typeof (origin as MoveOrigin).source.id === "string" &&
      !!(origin as MoveOrigin).source.id &&
      ((origin as MoveOrigin).parentId === null ||
        typeof (origin as MoveOrigin).parentId === "string") &&
      Number.isSafeInteger((origin as MoveOrigin).index) &&
      (origin as MoveOrigin).index >= 0,
  );
};

const deleteReceipt = (value: unknown): value is DeleteDirectoryUndoReceipt => {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;

  if (
    receipt.kind !== "delete" ||
    !Number.isSafeInteger(receipt.expectedCatalogRevision) ||
    (receipt.expectedCatalogRevision as number) < 0 ||
    !Array.isArray(receipt.roots) ||
    !receipt.roots.length ||
    receipt.roots.length > MAX_SOURCES
  )
    return false;

  return receipt.roots.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const root = entry as { root?: NodeRef; deleteBatchId?: unknown };

    return (
      !!root.root &&
      ["folder", "canvas"].includes(root.root.kind) &&
      typeof root.root.id === "string" &&
      !!root.root.id &&
      (root.root.kind === "folder"
        ? typeof root.deleteBatchId === "string" && !!root.deleteBatchId
        : root.deleteBatchId === null)
    );
  });
};

const restoreMovedSelection = async (
  workspaceId: string,
  userId: string,
  receipt: MoveDirectoryUndoReceipt,
): Promise<BatchUndoDirectoryResponse | null> => {
  const workspace = (
    await db
      .select({ revision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(activeWorkspace(workspaceId, userId))
      .limit(1)
  )[0];

  if (!workspace) return null;
  if (workspace.revision !== receipt.expectedCatalogRevision)
    conflict("DIRECTORY_UNDO_CONFLICT", "目录已变化，无法撤销这次移动");
  const refs = receipt.origins.map((origin) => origin.source);
  const keys = refs.map(keyOf);

  if (new Set(keys).size !== keys.length) failBatch("撤销凭证中的项目重复");
  const rows = await fetchSources(workspaceId, refs);

  if (
    rows.length !== refs.length ||
    rows.some((row) => row.parentId !== receipt.destinationParentId)
  )
    conflict("DIRECTORY_UNDO_CONFLICT", "所选项目已不在本次移动位置");
  const movedFolders = await subtreeFolders(workspaceId, refs);
  const originKeys = new Set<string>();

  for (const origin of receipt.origins) {
    const key = `${origin.parentId ?? "<root>"}:${origin.index}`;

    if (originKeys.has(key)) failBatch("撤销凭证中的原始位置重复");
    originKeys.add(key);
    if (origin.source.kind === "folder") {
      const parentDepth = await requireActiveParent(
        workspaceId,
        origin.parentId,
      );
      const depth = depthByFolderId(movedFolders, origin.source.id, () =>
        conflict("DIRECTORY_UNDO_CONFLICT", "撤销项目存在目录循环"),
      );

      if (
        (origin.parentId &&
          folderIsWithin(movedFolders, origin.parentId, origin.source.id, () =>
            conflict("DIRECTORY_UNDO_CONFLICT", "撤销项目存在目录循环"),
          )) ||
        (receipt.destinationParentId &&
          folderIsWithin(
            movedFolders,
            receipt.destinationParentId,
            origin.source.id,
            () => conflict("DIRECTORY_UNDO_CONFLICT", "撤销项目存在目录循环"),
          ))
      )
        conflict("DIRECTORY_UNDO_CONFLICT", "撤销位置位于所选文件夹子树内");
      if (parentDepth + depth > 5)
        conflict("RESTORE_LOCATION_REQUIRED", "原位置超过五层限制");
    }
  }

  const parents = [
    ...new Set([
      receipt.destinationParentId,
      ...receipt.origins.map((origin) => origin.parentId),
    ]),
  ];
  const siblings = await loadSiblings(workspaceId, parents);
  const sourceKeys = new Set(keys);
  const byParent = new Map<string | null, ActiveRow[]>();

  for (const parentId of parents)
    byParent.set(
      parentId,
      siblings.filter(
        (row) => row.parentId === parentId && !sourceKeys.has(keyOf(row.ref)),
      ),
    );
  for (const origin of [...receipt.origins].sort((a, b) => a.index - b.index)) {
    const list = byParent.get(origin.parentId)!;

    if (origin.index > list.length)
      conflict("DIRECTORY_UNDO_CONFLICT", "撤销凭证中的原始位置无效");
    const source = rows.find((row) => keyOf(row.ref) === keyOf(origin.source))!;

    list.splice(origin.index, 0, source);
  }

  const finalRows = parents.flatMap((parentId) =>
    byParent
      .get(parentId)!
      .map((row, position) => ({ ref: row.ref, parentId, position })),
  );
  const mapping = mappingJson(finalRows);
  const revisionGuard = workspaceAtRevision(
    workspaceId,
    userId,
    receipt.expectedCatalogRevision,
  );
  const result = await db.batch([
    db
      .update(tables.folders)
      .set({
        parentId: mappedParent(tables.folders, "folder", mapping),
        position: mappedPosition(tables.folders, "folder", mapping),
      })
      .where(
        and(
          eq(tables.folders.workspaceId, workspaceId),
          isNull(tables.folders.deletedAt),
          mappedIds(tables.folders, mapping, "folder"),
          revisionGuard,
        ),
      ),
    db
      .update(tables.canvases)
      .set({
        parentId: mappedParent(tables.canvases, "canvas", mapping),
        position: mappedPosition(tables.canvases, "canvas", mapping),
      })
      .where(
        and(
          eq(tables.canvases.workspaceId, workspaceId),
          isNull(tables.canvases.deletedAt),
          mappedIds(tables.canvases, mapping, "canvas"),
          revisionGuard,
        ),
      ),
    db
      .update(tables.workspaces)
      .set({ catalogRevision: sql`${tables.workspaces.catalogRevision} + 1` })
      .where(
        and(
          activeWorkspace(workspaceId, userId),
          eq(
            tables.workspaces.catalogRevision,
            receipt.expectedCatalogRevision,
          ),
        ),
      )
      .returning({ catalogRevision: tables.workspaces.catalogRevision }),
  ]);
  const revision = result[2][0]?.catalogRevision;

  if (revision === undefined)
    return conflict("DIRECTORY_UNDO_CONFLICT", "目录已变化，无法撤销这次移动");

  return { kind: "move", catalogRevision: revision };
};

const restoreDeletedSelection = async (
  workspaceId: string,
  userId: string,
  receipt: DeleteDirectoryUndoReceipt,
  now = Date.now(),
): Promise<BatchUndoDirectoryResponse | null> => {
  const workspace = (
    await db
      .select({ revision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(activeWorkspace(workspaceId, userId))
      .limit(1)
  )[0];

  if (!workspace) return null;
  if (workspace.revision !== receipt.expectedCatalogRevision)
    conflict("DIRECTORY_UNDO_CONFLICT", "目录已变化，无法撤销这次删除");
  const folderRoots = receipt.roots.filter(
    (entry) => entry.root.kind === "folder",
  );
  const canvasRoots = receipt.roots.filter(
    (entry) => entry.root.kind === "canvas",
  );
  const rootKeys = receipt.roots.map((entry) => keyOf(entry.root));
  const batchIds = folderRoots.map((entry) => entry.deleteBatchId!);

  if (
    new Set(rootKeys).size !== rootKeys.length ||
    new Set(batchIds).size !== batchIds.length
  )
    failBatch("撤销凭证中的项目重复");
  const folders = await receiptFolders(workspaceId, batchIds);
  const folderRootIdsJson = json(
    folderRoots.map((entry) => ({ id: entry.root.id })),
  );
  const currentRoots = folderRoots.length
    ? await db
        .select({
          id: tables.folders.id,
          deleteBatchId: tables.folders.deleteBatchId,
        })
        .from(tables.folders)
        .where(
          and(
            eq(tables.folders.workspaceId, workspaceId),
            sql`${tables.folders.id} IN (SELECT json_extract(value, '$.id') FROM json_each(${folderRootIdsJson}))`,
          ),
        )
    : [];
  const cutoff = new Date(now - RETENTION_MS).toISOString();

  for (const root of folderRoots) {
    const currentRoot = currentRoots.find((row) => row.id === root.root.id);

    if (currentRoot && currentRoot.deleteBatchId !== root.deleteBatchId)
      conflict("DIRECTORY_UNDO_CONFLICT", "撤销回执中的删除批次与来源不匹配");
  }

  if (
    folders.some(
      (row) =>
        row.purging ||
        !row.deletedAt ||
        row.deletedAt <= cutoff ||
        !row.deleteBatchId,
    )
  )
    conflict("RECYCLE_UNAVAILABLE", "部分回收项目已过期或正在清理");
  for (const root of folderRoots) {
    const members = folders.filter(
      (row) => row.deleteBatchId === root.deleteBatchId,
    );

    if (!members.some((row) => row.id === root.root.id))
      conflict("RECYCLE_UNAVAILABLE", "回收批次不存在或已过期");
    const depth = depthByFolderId(
      members.map((row) => ({
        id: row.id,
        parentId: row.parentId,
        position: row.position,
      })),
      root.root.id,
      () => conflict("DIRECTORY_UNDO_CONFLICT", "撤销项目存在目录循环"),
    );
    const parentDepth = await requireActiveParent(
      workspaceId,
      members.find((row) => row.id === root.root.id)!.parentId,
    );

    if (parentDepth + depth > 5)
      conflict("RESTORE_LOCATION_REQUIRED", "原位置超过五层限制");
  }

  const canvasRootsJson = sourceJson(canvasRoots.map((entry) => entry.root));
  const directCanvasRows = canvasRoots.length
    ? await db
        .select()
        .from(tables.canvases)
        .where(
          and(
            eq(tables.canvases.workspaceId, workspaceId),
            rowsetRefs(tables.canvases.id, "canvas", canvasRootsJson),
            isNull(tables.canvases.deleteBatchId),
          ),
        )
    : [];

  if (
    directCanvasRows.length !== canvasRoots.length ||
    directCanvasRows.some(
      (row) => row.purging || !row.deletedAt || row.deletedAt <= cutoff,
    )
  )
    conflict("RECYCLE_UNAVAILABLE", "部分画布已过期或正在清理");
  for (const canvas of directCanvasRows)
    await requireActiveParent(workspaceId, canvas.parentId);
  const canvasRows = await db
    .select()
    .from(tables.canvases)
    .where(
      and(
        eq(tables.canvases.workspaceId, workspaceId),
        batchIds.length
          ? sql`${tables.canvases.deleteBatchId} IN (SELECT json_extract(value, '$.deleteBatchId') FROM json_each(${json(batchIds.map((deleteBatchId) => ({ deleteBatchId })))}))`
          : undefined,
      ),
    );

  if (
    canvasRows.some(
      (row) => row.purging || !row.deletedAt || row.deletedAt <= cutoff,
    )
  )
    conflict("RECYCLE_UNAVAILABLE", "部分画布已过期或正在清理");
  const folderBatchJson = json(
    batchIds.map((deleteBatchId) => ({ deleteBatchId })),
  );
  const directIdsJson = sourceJson(canvasRoots.map((entry) => entry.root));
  const folderIdsJson = json(folders.map((row) => ({ id: row.id })));
  const canvasIdsJson = json(
    [...canvasRows, ...directCanvasRows].map((row) => ({ id: row.id })),
  );
  const restoreReady = sql`
    (SELECT COUNT(*) FROM folders
      WHERE workspace_id = ${workspaceId}
        AND id IN (SELECT json_extract(value, '$.id') FROM json_each(${folderIdsJson}))) = ${folders.length}
    AND NOT EXISTS (SELECT 1 FROM folders
      WHERE workspace_id = ${workspaceId} AND purging != 0
        AND id IN (SELECT json_extract(value, '$.id') FROM json_each(${folderIdsJson})))
    AND (SELECT COUNT(*) FROM canvases
      WHERE workspace_id = ${workspaceId}
        AND id IN (SELECT json_extract(value, '$.id') FROM json_each(${canvasIdsJson}))) = ${canvasRows.length + directCanvasRows.length}
    AND NOT EXISTS (SELECT 1 FROM canvases
      WHERE workspace_id = ${workspaceId} AND purging != 0
        AND id IN (SELECT json_extract(value, '$.id') FROM json_each(${canvasIdsJson})))
  `;
  const revisionGuard = workspaceAtRevision(
    workspaceId,
    userId,
    receipt.expectedCatalogRevision,
  );
  const result = await db.batch([
    db
      .update(tables.folders)
      .set({ deletedAt: null, deleteBatchId: null })
      .where(
        and(
          eq(tables.folders.workspaceId, workspaceId),
          batchIds.length
            ? sql`${tables.folders.deleteBatchId} IN (SELECT json_extract(value, '$.deleteBatchId') FROM json_each(${folderBatchJson}))`
            : sql`0 = 1`,
          isNotNull(tables.folders.deletedAt),
          eq(tables.folders.purging, 0),
          revisionGuard,
          restoreReady,
        ),
      )
      .returning({ id: tables.folders.id }),
    db
      .update(tables.canvases)
      .set({
        deletedAt: null,
        deleteBatchId: null,
        recycleRevision: sql`${tables.canvases.recycleRevision} + 1`,
        recyclePending: 1,
      })
      .where(
        and(
          eq(tables.canvases.workspaceId, workspaceId),
          or(
            batchIds.length
              ? sql`${tables.canvases.deleteBatchId} IN (SELECT json_extract(value, '$.deleteBatchId') FROM json_each(${folderBatchJson}))`
              : undefined,
            canvasRoots.length
              ? rowsetRefs(tables.canvases.id, "canvas", directIdsJson)
              : undefined,
          ),
          isNotNull(tables.canvases.deletedAt),
          eq(tables.canvases.purging, 0),
          revisionGuard,
          restoreReady,
        ),
      )
      .returning({ id: tables.canvases.id }),
    db
      .update(tables.workspaces)
      .set({ catalogRevision: sql`${tables.workspaces.catalogRevision} + 1` })
      .where(
        and(
          activeWorkspace(workspaceId, userId),
          eq(
            tables.workspaces.catalogRevision,
            receipt.expectedCatalogRevision,
          ),
          restoreReady,
        ),
      )
      .returning({ catalogRevision: tables.workspaces.catalogRevision }),
  ]);
  const revision = result[2][0]?.catalogRevision;

  if (revision === undefined)
    return conflict("DIRECTORY_UNDO_CONFLICT", "目录已变化，无法撤销这次删除");
  const restoredFolderIds = result[0].map((row) => row.id);
  const restoredCanvasIds = result[1].map((row) => row.id);

  return {
    kind: "delete",
    catalogRevision: revision,
    restoredFolderIds,
    restoredCanvasIds,
  };
};

export async function undoDirectorySelection(
  workspaceId: string,
  userId: string,
  request: BatchUndoDirectoryRequest,
): Promise<BatchUndoDirectoryResponse | null> {
  if (moveReceipt(request.receipt))
    return restoreMovedSelection(workspaceId, userId, request.receipt);
  if (deleteReceipt(request.receipt))
    return restoreDeletedSelection(workspaceId, userId, request.receipt);

  return failBatch("撤销凭证无效");
}
