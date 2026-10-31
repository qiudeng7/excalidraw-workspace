import { db } from "@nuxthub/db";
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  isNotNull,
  gt,
  lte,
  not,
  or,
  sql,
} from "drizzle-orm";
import {
  canvases,
  folders,
  directoryFavorites,
  workspaces,
  userNavigation,
  workspaceNavigation,
  canvasSessions,
} from "#server/db/schema";
import type { RecycleEntry } from "#shared/contracts";
import type {
  DirectoryRecycleEntry,
  FolderRecycleEntry,
} from "#shared/directory-contracts";

export const RECYCLE_RETENTION = 30 * 86400000;

export const recycleExpiry = (deletedAt: string) =>
  new Date(Date.parse(deletedAt) + RECYCLE_RETENTION).toISOString();
const cutoff = (now: number) => new Date(now - RECYCLE_RETENTION).toISOString();

export async function recycleEntries(
  userId: string,
  now = Date.now(),
): Promise<DirectoryRecycleEntry[]> {
  const [spaces, files, folderRoots] = await db.batch([
    db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.userId, userId),
          isNotNull(workspaces.deletedAt),
          eq(workspaces.deleting, 0),
          gt(workspaces.deletedAt, cutoff(now)),
        ),
      ),
    db
      .select({
        id: canvases.id,
        name: canvases.name,
        workspaceId: canvases.workspaceId,
        deletedAt: canvases.deletedAt,
        workspaceName: sql<string>`${workspaces.name}`.as("workspaceName"),
      })
      .from(canvases)
      .innerJoin(workspaces, eq(canvases.workspaceId, workspaces.id))
      .where(
        and(
          eq(workspaces.userId, userId),
          isNull(workspaces.deletedAt),
          eq(workspaces.deleting, 0),
          isNotNull(canvases.deletedAt),
          isNull(canvases.deleteBatchId),
          eq(canvases.purging, 0),
          gt(canvases.deletedAt, cutoff(now)),
        ),
      ),
    db
      .select({
        id: folders.id,
        name: folders.name,
        workspaceId: folders.workspaceId,
        parentId: folders.parentId,
        deleteBatchId: folders.deleteBatchId,
        deletedAt: folders.deletedAt,
        workspaceName: sql<string>`${workspaces.name}`.as("workspaceName"),
      })
      .from(folders)
      .innerJoin(workspaces, eq(folders.workspaceId, workspaces.id))
      .where(
        and(
          eq(workspaces.userId, userId),
          isNull(workspaces.deletedAt),
          eq(workspaces.deleting, 0),
          isNotNull(folders.deletedAt),
          isNotNull(folders.deleteBatchId),
          eq(folders.purging, 0),
          gt(folders.deletedAt, cutoff(now)),
          sql`NOT EXISTS (SELECT 1 FROM folders parent WHERE parent.id = ${folders.parentId}
        AND parent.delete_batch_id = ${folders.deleteBatchId})`,
        ),
      ),
  ]);
  const recycledFolders: FolderRecycleEntry[] = [];

  for (const root of folderRoots) {
    if (!root.deleteBatchId || !root.deletedAt) continue;
    const batch = await db
      .select({ id: folders.id, parentId: folders.parentId })
      .from(folders)
      .where(
        and(
          eq(folders.workspaceId, root.workspaceId),
          eq(folders.deleteBatchId, root.deleteBatchId),
          eq(folders.purging, 0),
          gt(folders.deletedAt, cutoff(now)),
        ),
      );
    const levels = new Map([[root.id, 1]]);
    let deepest = 1;

    for (let pass = 0; pass < 5; pass += 1) {
      let found = false;

      for (const folder of batch) {
        if (
          !folder.parentId ||
          !levels.has(folder.parentId) ||
          levels.has(folder.id)
        )
          continue;
        const depth = levels.get(folder.parentId)! + 1;

        levels.set(folder.id, depth);
        deepest = Math.max(deepest, depth);
        found = true;
      }

      if (!found) break;
    }

    recycledFolders.push({
      kind: "folder",
      id: root.id,
      name: root.name,
      workspaceId: root.workspaceId,
      workspaceName: root.workspaceName,
      parentId: root.parentId,
      deleteBatchId: root.deleteBatchId,
      deletedAt: root.deletedAt,
      expiresAt: recycleExpiry(root.deletedAt),
      subtreeDepth: deepest,
    });
  }

  return [
    ...spaces.map((row): RecycleEntry => ({
      kind: "workspace",
      id: row.id,
      name: row.name,
      deletedAt: row.deletedAt!,
      expiresAt: recycleExpiry(row.deletedAt!),
    })),
    ...files.map((row): RecycleEntry => ({
      kind: "canvas",
      id: row.id,
      name: row.name,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      deletedAt: row.deletedAt!,
      expiresAt: recycleExpiry(row.deletedAt!),
    })),
    ...recycledFolders,
  ].sort(
    (a, b) =>
      b.deletedAt.localeCompare(a.deletedAt) || a.id.localeCompare(b.id),
  );
}

/** Metadata and navigation are one atomic native batch; blobs remain referenced. */
export async function recycleCanvas(
  id: string,
  userId: string,
  workspaceId: string,
  revision: number,
  now = new Date().toISOString(),
) {
  const owner = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.userId, userId),
        eq(workspaces.deleting, 0),
        isNull(workspaces.deletedAt),
        eq(workspaces.catalogRevision, revision),
      ),
    );
  const results = await db.batch([
    db
      .update(canvases)
      .set({
        deletedAt: now,
        revision: sql`${canvases.revision}+1`,
        recycleRevision: sql`${canvases.recycleRevision}+1`,
        recyclePending: 1,
      })
      .where(
        and(
          eq(canvases.id, id),
          eq(canvases.workspaceId, workspaceId),
          isNull(canvases.deletedAt),
          inArray(canvases.workspaceId, owner),
        ),
      )
      .returning({ id: canvases.id }),
    db
      .update(workspaces)
      .set({ catalogRevision: sql`${workspaces.catalogRevision}+1` })
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.catalogRevision, revision),
          sql`EXISTS (SELECT 1 FROM canvases WHERE id = ${id} AND deleted_at = ${now})`,
        ),
      ),
    db
      .update(userNavigation)
      .set({ lastCanvasId: null, revision: sql`${userNavigation.revision}+1` })
      .where(
        and(
          eq(userNavigation.userId, userId),
          eq(userNavigation.lastCanvasId, id),
          sql`EXISTS (SELECT 1 FROM canvases WHERE id = ${id} AND deleted_at = ${now})`,
        ),
      ),
    db
      .update(workspaceNavigation)
      .set({ lastCanvasId: null })
      .where(
        and(
          eq(workspaceNavigation.userId, userId),
          eq(workspaceNavigation.lastCanvasId, id),
          sql`EXISTS (SELECT 1 FROM canvases WHERE id = ${id} AND deleted_at = ${now})`,
        ),
      ),
    db
      .delete(canvasSessions)
      .where(
        and(
          eq(canvasSessions.canvasId, id),
          sql`EXISTS (SELECT 1 FROM canvases WHERE id = ${id} AND deleted_at = ${now})`,
        ),
      ),
  ]);

  return results[0].length;
}

export async function recycleWorkspace(
  id: string,
  userId: string,
  now = new Date().toISOString(),
) {
  const results = await db.batch([
    db
      .update(workspaces)
      .set({
        deletedAt: now,
        catalogRevision: sql`${workspaces.catalogRevision}+1`,
      })
      .where(
        and(
          eq(workspaces.id, id),
          eq(workspaces.userId, userId),
          isNull(workspaces.deletedAt),
          eq(workspaces.deleting, 0),
        ),
      )
      .returning({ id: workspaces.id }),
    db
      .update(canvases)
      .set({
        revision: sql`${canvases.revision}+1`,
        recycleRevision: sql`${canvases.recycleRevision}+1`,
        recyclePending: 1,
      })
      .where(
        and(
          eq(canvases.workspaceId, id),
          sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${id} AND user_id = ${userId} AND deleted_at = ${now})`,
        ),
      ),
    db
      .update(userNavigation)
      .set({
        lastWorkspaceId: null,
        lastCanvasId: null,
        revision: sql`${userNavigation.revision}+1`,
      })
      .where(
        and(
          eq(userNavigation.userId, userId),
          eq(userNavigation.lastWorkspaceId, id),
          sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${id} AND deleted_at = ${now})`,
        ),
      ),
    db
      .delete(workspaceNavigation)
      .where(
        and(
          eq(workspaceNavigation.userId, userId),
          eq(workspaceNavigation.workspaceId, id),
          sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${id} AND deleted_at = ${now})`,
        ),
      ),
    db.delete(canvasSessions).where(
      inArray(
        canvasSessions.canvasId,
        db
          .select({ id: canvases.id })
          .from(canvases)
          .innerJoin(workspaces, eq(canvases.workspaceId, workspaces.id))
          .where(
            and(
              eq(workspaces.id, id),
              eq(workspaces.userId, userId),
              eq(workspaces.deletedAt, now),
            ),
          ),
      ),
    ),
  ]);

  return results[0].length;
}

export async function restoreRecycleEntry(
  kind: RecycleEntry["kind"],
  id: string,
  userId: string,
  now = Date.now(),
) {
  if (kind === "workspace") {
    const result = await db.batch([
      db
        .update(canvases)
        .set({
          recycleRevision: sql`${canvases.recycleRevision}+1`,
          recyclePending: 1,
        })
        .where(
          inArray(
            canvases.workspaceId,
            db
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(
                and(
                  eq(workspaces.id, id),
                  eq(workspaces.userId, userId),
                  eq(workspaces.deleting, 0),
                  gt(workspaces.deletedAt, cutoff(now)),
                ),
              ),
          ),
        ),
      db
        .update(workspaces)
        .set({
          deletedAt: null,
          catalogRevision: sql`${workspaces.catalogRevision}+1`,
        })
        .where(
          and(
            eq(workspaces.id, id),
            eq(workspaces.userId, userId),
            eq(workspaces.deleting, 0),
            gt(workspaces.deletedAt, cutoff(now)),
          ),
        )
        .returning({ id: workspaces.id }),
    ]);

    if (result[1].length) return 1;

    return (
      await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.id, id),
            eq(workspaces.userId, userId),
            eq(workspaces.deleting, 0),
            isNull(workspaces.deletedAt),
          ),
        )
    ).length;
  }

  if (kind !== "canvas") return 0;

  const owner = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.userId, userId),
        eq(workspaces.deleting, 0),
        isNull(workspaces.deletedAt),
      ),
    );
  const result = await db.batch([
    db
      .update(workspaces)
      .set({ catalogRevision: sql`${workspaces.catalogRevision}+1` })
      .where(
        inArray(
          workspaces.id,
          db
            .select({ workspaceId: canvases.workspaceId })
            .from(canvases)
            .where(
              and(
                eq(canvases.id, id),
                inArray(canvases.workspaceId, owner),
                eq(canvases.purging, 0),
                gt(canvases.deletedAt, cutoff(now)),
              ),
            ),
        ),
      ),
    db
      .update(canvases)
      .set({
        deletedAt: null,
        recycleRevision: sql`${canvases.recycleRevision}+1`,
        recyclePending: 1,
      })
      .where(
        and(
          eq(canvases.id, id),
          inArray(canvases.workspaceId, owner),
          eq(canvases.purging, 0),
          gt(canvases.deletedAt, cutoff(now)),
        ),
      )
      .returning({ id: canvases.id }),
  ]);

  if (result[1].length) return 1;

  return (
    await db
      .select({ id: canvases.id })
      .from(canvases)
      .where(
        and(
          eq(canvases.id, id),
          inArray(canvases.workspaceId, owner),
          eq(canvases.purging, 0),
          isNull(canvases.deletedAt),
        ),
      )
  ).length;
}

/** Pin irreversible intent before contacting rooms, so restore cannot race a retry. */
export async function markRecyclePurge(
  kind: DirectoryRecycleEntry["kind"],
  id: string,
  userId?: string,
  now = Date.now(),
) {
  const owner = userId ? eq(workspaces.userId, userId) : undefined;

  if (kind === "workspace") {
    const rows = await db
      .update(workspaces)
      .set({ deleting: 1 })
      .where(
        and(
          eq(workspaces.id, id),
          owner,
          isNotNull(workspaces.deletedAt),
          userId
            ? undefined
            : or(
                eq(workspaces.deleting, 1),
                lte(workspaces.deletedAt, cutoff(now)),
              ),
        ),
      )
      .returning({ id: workspaces.id });

    return rows.length;
  }

  if (kind === "folder") {
    const root = (
      await db
        .select({
          workspaceId: folders.workspaceId,
          deleteBatchId: folders.deleteBatchId,
        })
        .from(folders)
        .innerJoin(workspaces, eq(folders.workspaceId, workspaces.id))
        .where(
          and(
            eq(folders.id, id),
            isNotNull(folders.deletedAt),
            isNotNull(folders.deleteBatchId),
            eq(workspaces.deleting, 0),
            isNull(workspaces.deletedAt),
            owner,
            sql`NOT EXISTS (SELECT 1 FROM folders parent WHERE parent.id = ${folders.parentId}
        AND parent.delete_batch_id = ${folders.deleteBatchId})`,
            userId
              ? undefined
              : or(eq(folders.purging, 1), lte(folders.deletedAt, cutoff(now))),
          ),
        )
        .limit(1)
    )[0];

    if (!root?.deleteBatchId) return 0;
    const foldersMarked = await db
      .update(folders)
      .set({ purging: 1 })
      .where(
        and(
          eq(folders.workspaceId, root.workspaceId),
          eq(folders.deleteBatchId, root.deleteBatchId),
          isNotNull(folders.deletedAt),
          userId
            ? undefined
            : or(eq(folders.purging, 1), lte(folders.deletedAt, cutoff(now))),
        ),
      )
      .returning({ id: folders.id });

    await db
      .update(canvases)
      .set({ purging: 1 })
      .where(
        and(
          eq(canvases.workspaceId, root.workspaceId),
          eq(canvases.deleteBatchId, root.deleteBatchId),
          isNotNull(canvases.deletedAt),
        ),
      );

    return foldersMarked.length;
  }

  const rows = await db
    .update(canvases)
    .set({ purging: 1 })
    .where(
      and(
        eq(canvases.id, id),
        isNotNull(canvases.deletedAt),
        inArray(
          canvases.workspaceId,
          db.select({ id: workspaces.id }).from(workspaces).where(owner),
        ),
        userId
          ? undefined
          : or(eq(canvases.purging, 1), lte(canvases.deletedAt, cutoff(now))),
      ),
    )
    .returning({ id: canvases.id });

  return rows.length;
}
