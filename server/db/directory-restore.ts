import { db } from "@nuxthub/db";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import * as tables from "#server/db/schema";
import type {
  RestoreCanvasResponse,
  RestoreDirectoryRequest,
  RestoreFolderResponse,
} from "#shared/directory-contracts";
import { ApiError } from "#server/utils/http";

const cutoff = () => new Date(Date.now() - 30 * 86400000).toISOString();
const notPurging = <T extends typeof tables.folders | typeof tables.canvases>(
  table: T,
) => eq(table.purging, 0);

const requireRestoreParent = async (
  workspaceId: string,
  parentId: string | null,
  batchId?: string,
) => {
  if (!parentId) return 0;
  const row = (
    await db
      .select({ parentId: tables.folders.parentId })
      .from(tables.folders)
      .where(
        and(
          eq(tables.folders.id, parentId),
          eq(tables.folders.workspaceId, workspaceId),
          isNull(tables.folders.deletedAt),
          batchId
            ? sql`${tables.folders.deleteBatchId} IS NOT ${batchId}`
            : undefined,
        ),
      )
      .limit(1)
  )[0];

  if (!row)
    throw new ApiError(
      409,
      "RESTORE_LOCATION_REQUIRED",
      "原文件夹已不可用，请选择其他位置",
    );
  let depth = 1;
  let next = row.parentId;

  while (next) {
    const ancestor = (
      await db
        .select({ parentId: tables.folders.parentId })
        .from(tables.folders)
        .where(
          and(
            eq(tables.folders.id, next),
            eq(tables.folders.workspaceId, workspaceId),
            isNull(tables.folders.deletedAt),
          ),
        )
        .limit(1)
    )[0];

    if (!ancestor)
      throw new ApiError(
        409,
        "RESTORE_LOCATION_REQUIRED",
        "原文件夹路径已不可用，请选择其他位置",
      );
    depth += 1;
    next = ancestor.parentId;
  }

  return depth;
};

const activeWorkspaceRevision = async (workspaceId: string, userId: string) =>
  (
    await db
      .select({ revision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(
        and(
          eq(tables.workspaces.id, workspaceId),
          eq(tables.workspaces.userId, userId),
          eq(tables.workspaces.deleting, 0),
          isNull(tables.workspaces.deletedAt),
        ),
      )
      .limit(1)
  )[0]?.revision;

const retryRestoredCanvas = async (
  id: string,
  userId: string,
  request: RestoreDirectoryRequest,
): Promise<RestoreCanvasResponse | null> => {
  const row = (
    await db
      .select({ canvas: tables.canvases, workspace: tables.workspaces })
      .from(tables.canvases)
      .innerJoin(
        tables.workspaces,
        eq(tables.canvases.workspaceId, tables.workspaces.id),
      )
      .where(
        and(
          eq(tables.canvases.id, id),
          eq(tables.workspaces.userId, userId),
          eq(tables.workspaces.deleting, 0),
          isNull(tables.workspaces.deletedAt),
          isNull(tables.canvases.deletedAt),
          isNull(tables.canvases.deleteBatchId),
          notPurging(tables.canvases),
          eq(tables.canvases.recyclePending, 1),
        ),
      )
      .limit(1)
  )[0];

  if (!row) return null;
  const parentId =
    request.parentId === undefined ? row.canvas.parentId : request.parentId;

  if (parentId !== row.canvas.parentId)
    throw new ApiError(
      409,
      "RESTORE_LOCATION_REQUIRED",
      "画布已恢复到其他位置",
    );
  if (parentId !== null)
    await requireRestoreParent(row.canvas.workspaceId, parentId);
  const revision = await activeWorkspaceRevision(
    row.canvas.workspaceId,
    userId,
  );

  return revision === undefined
    ? null
    : { catalogRevision: revision, canvasId: id, parentId };
};

const activeFolderSubtreeIds = async (workspaceId: string, rootId: string) => {
  const folders = await db
    .select({ id: tables.folders.id, parentId: tables.folders.parentId })
    .from(tables.folders)
    .where(
      and(
        eq(tables.folders.workspaceId, workspaceId),
        isNull(tables.folders.deletedAt),
        isNull(tables.folders.deleteBatchId),
        notPurging(tables.folders),
      ),
    );
  const folderIds = new Set([rootId]);
  let added = true;

  while (added) {
    added = false;

    for (const folder of folders) {
      if (
        folder.parentId &&
        folderIds.has(folder.parentId) &&
        !folderIds.has(folder.id)
      ) {
        folderIds.add(folder.id);
        added = true;
      }
    }
  }

  return [...folderIds];
};

const retryRestoredFolder = async (
  id: string,
  userId: string,
  request: RestoreDirectoryRequest,
): Promise<RestoreFolderResponse | null> => {
  const root = (
    await db
      .select({ folder: tables.folders, workspace: tables.workspaces })
      .from(tables.folders)
      .innerJoin(
        tables.workspaces,
        eq(tables.folders.workspaceId, tables.workspaces.id),
      )
      .where(
        and(
          eq(tables.folders.id, id),
          eq(tables.workspaces.userId, userId),
          eq(tables.workspaces.deleting, 0),
          isNull(tables.workspaces.deletedAt),
          isNull(tables.folders.deletedAt),
          isNull(tables.folders.deleteBatchId),
          notPurging(tables.folders),
        ),
      )
      .limit(1)
  )[0];

  if (!root) return null;
  const parentId =
    request.parentId === undefined ? root.folder.parentId : request.parentId;

  if (parentId !== root.folder.parentId)
    throw new ApiError(
      409,
      "RESTORE_LOCATION_REQUIRED",
      "文件夹已恢复到其他位置",
    );
  if (parentId !== null)
    await requireRestoreParent(root.folder.workspaceId, parentId);
  const folderIds = await activeFolderSubtreeIds(root.folder.workspaceId, id);
  const pendingCanvases = await db
    .select({ id: tables.canvases.id })
    .from(tables.canvases)
    .where(
      and(
        eq(tables.canvases.workspaceId, root.folder.workspaceId),
        inArray(tables.canvases.parentId, folderIds),
        isNull(tables.canvases.deletedAt),
        isNull(tables.canvases.deleteBatchId),
        notPurging(tables.canvases),
        eq(tables.canvases.recyclePending, 1),
      ),
    );

  if (!pendingCanvases.length) return null;
  const revision = await activeWorkspaceRevision(
    root.folder.workspaceId,
    userId,
  );

  return revision === undefined
    ? null
    : {
        catalogRevision: revision,
        restoredFolderIds: [],
        restoredCanvasIds: pendingCanvases.map((canvas) => canvas.id),
      };
};

export async function restoreDirectoryCanvas(
  id: string,
  userId: string,
  request: RestoreDirectoryRequest,
): Promise<RestoreCanvasResponse | null> {
  const row = (
    await db
      .select({ canvas: tables.canvases, workspace: tables.workspaces })
      .from(tables.canvases)
      .innerJoin(
        tables.workspaces,
        eq(tables.canvases.workspaceId, tables.workspaces.id),
      )
      .where(
        and(
          eq(tables.canvases.id, id),
          eq(tables.workspaces.userId, userId),
          eq(tables.workspaces.deleting, 0),
          isNull(tables.workspaces.deletedAt),
          isNull(tables.canvases.deleteBatchId),
          notPurging(tables.canvases),
          gt(tables.canvases.deletedAt, cutoff()),
        ),
      )
      .limit(1)
  )[0];

  if (!row) return retryRestoredCanvas(id, userId, request);
  const parentId =
    request.parentId === undefined ? row.canvas.parentId : request.parentId;

  if (parentId !== null)
    await requireRestoreParent(row.canvas.workspaceId, parentId);
  const revision = await activeWorkspaceRevision(
    row.canvas.workspaceId,
    userId,
  );

  if (revision === undefined) return null;

  const result = await db.batch([
    db
      .update(tables.canvases)
      .set({
        deletedAt: null,
        parentId,
        recycleRevision: sql`${tables.canvases.recycleRevision} + 1`,
        recyclePending: 1,
      })
      .where(
        and(
          eq(tables.canvases.id, id),
          eq(tables.canvases.workspaceId, row.canvas.workspaceId),
          isNull(tables.canvases.deleteBatchId),
          notPurging(tables.canvases),
          gt(tables.canvases.deletedAt, cutoff()),
          sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${row.canvas.workspaceId}
        AND user_id = ${userId} AND catalog_revision = ${revision}
        AND deleting = 0 AND deleted_at IS NULL)`,
        ),
      )
      .returning({ id: tables.canvases.id }),
    db
      .update(tables.workspaces)
      .set({ catalogRevision: sql`${tables.workspaces.catalogRevision} + 1` })
      .where(
        and(
          eq(tables.workspaces.id, row.canvas.workspaceId),
          eq(tables.workspaces.userId, userId),
          eq(tables.workspaces.catalogRevision, revision),
          eq(tables.workspaces.deleting, 0),
          isNull(tables.workspaces.deletedAt),
          sql`EXISTS (SELECT 1 FROM canvases WHERE id = ${id} AND deleted_at IS NULL)`,
        ),
      )
      .returning({ revision: tables.workspaces.catalogRevision }),
  ]);

  if (!result[0].length || !result[1].length) return null;

  return { catalogRevision: result[1][0]!.revision, canvasId: id, parentId };
}

export async function restoreDirectoryFolder(
  id: string,
  userId: string,
  request: RestoreDirectoryRequest,
): Promise<RestoreFolderResponse | null> {
  const root = (
    await db
      .select({ folder: tables.folders, workspace: tables.workspaces })
      .from(tables.folders)
      .innerJoin(
        tables.workspaces,
        eq(tables.folders.workspaceId, tables.workspaces.id),
      )
      .where(
        and(
          eq(tables.folders.id, id),
          eq(tables.workspaces.userId, userId),
          eq(tables.workspaces.deleting, 0),
          isNull(tables.workspaces.deletedAt),
          notPurging(tables.folders),
          gt(tables.folders.deletedAt, cutoff()),
        ),
      )
      .limit(1)
  )[0];

  if (!root) return retryRestoredFolder(id, userId, request);
  if (!root.folder.deleteBatchId) return null;
  const batchId = root.folder.deleteBatchId;
  const parentId =
    request.parentId === undefined ? root.folder.parentId : request.parentId;
  const folders = await db
    .select()
    .from(tables.folders)
    .where(
      and(
        eq(tables.folders.workspaceId, root.folder.workspaceId),
        eq(tables.folders.deleteBatchId, batchId),
        notPurging(tables.folders),
        gt(tables.folders.deletedAt, cutoff()),
      ),
    );

  if (!folders.some((folder) => folder.id === id)) return null;
  let subtreeDepth = 1;
  const depthById = new Map([[id, 1]]);

  for (let level = 2; level <= 5; level += 1) {
    let found = false;

    for (const folder of folders) {
      if (
        folder.parentId &&
        depthById.has(folder.parentId) &&
        !depthById.has(folder.id)
      ) {
        depthById.set(folder.id, level);
        subtreeDepth = level;
        found = true;
      }
    }

    if (!found) break;
  }

  const parentDepth = await requireRestoreParent(
    root.folder.workspaceId,
    parentId,
    batchId,
  );

  if (parentDepth + subtreeDepth > 5)
    throw new ApiError(
      409,
      "RESTORE_LOCATION_REQUIRED",
      "原位置超过五层限制，请选择其他位置",
    );

  const revision = await activeWorkspaceRevision(
    root.folder.workspaceId,
    userId,
  );

  if (revision === undefined) return null;
  const folderIds = folders.map((folder) => folder.id);
  const canvases = await db
    .select({ id: tables.canvases.id })
    .from(tables.canvases)
    .where(
      and(
        eq(tables.canvases.workspaceId, root.folder.workspaceId),
        eq(tables.canvases.deleteBatchId, batchId),
        notPurging(tables.canvases),
        gt(tables.canvases.deletedAt, cutoff()),
      ),
    );
  const result = await db.batch([
    db
      .update(tables.folders)
      .set({
        deletedAt: null,
        deleteBatchId: null,
      })
      .where(
        and(
          inArray(tables.folders.id, folderIds),
          eq(tables.folders.workspaceId, root.folder.workspaceId),
          eq(tables.folders.deleteBatchId, batchId),
          notPurging(tables.folders),
          gt(tables.folders.deletedAt, cutoff()),
          sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${root.folder.workspaceId}
        AND user_id = ${userId} AND catalog_revision = ${revision}
        AND deleting = 0 AND deleted_at IS NULL)`,
        ),
      ),
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
          eq(tables.canvases.workspaceId, root.folder.workspaceId),
          eq(tables.canvases.deleteBatchId, batchId),
          notPurging(tables.canvases),
          gt(tables.canvases.deletedAt, cutoff()),
          sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${root.folder.workspaceId}
        AND user_id = ${userId} AND catalog_revision = ${revision}
        AND deleting = 0 AND deleted_at IS NULL)`,
        ),
      )
      .returning({ id: tables.canvases.id }),
    db
      .update(tables.folders)
      .set({ parentId })
      .where(
        and(
          eq(tables.folders.id, id),
          eq(tables.folders.workspaceId, root.folder.workspaceId),
          isNull(tables.folders.deletedAt),
          isNull(tables.folders.deleteBatchId),
          notPurging(tables.folders),
          sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${root.folder.workspaceId}
        AND user_id = ${userId} AND catalog_revision = ${revision}
        AND deleting = 0 AND deleted_at IS NULL)`,
        ),
      ),
    db
      .update(tables.workspaces)
      .set({ catalogRevision: sql`${tables.workspaces.catalogRevision} + 1` })
      .where(
        and(
          eq(tables.workspaces.id, root.folder.workspaceId),
          eq(tables.workspaces.userId, userId),
          eq(tables.workspaces.catalogRevision, revision),
          eq(tables.workspaces.deleting, 0),
          isNull(tables.workspaces.deletedAt),
          sql`EXISTS (SELECT 1 FROM folders WHERE id = ${id} AND deleted_at IS NULL)`,
        ),
      )
      .returning({ revision: tables.workspaces.catalogRevision }),
  ]);

  if (!result[3].length) return null;

  return {
    catalogRevision: result[3][0]!.revision,
    restoredFolderIds: folderIds,
    restoredCanvasIds: result[1].map((row) => row.id),
  };
}
