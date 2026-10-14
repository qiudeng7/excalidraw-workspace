import { db } from "@nuxthub/db";
import {
  and,
  eq,
  inArray,
  isNull,
  isNotNull,
  gt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  canvases,
  workspaces,
  userNavigation,
  workspaceNavigation,
  canvasSessions,
} from "#server/db/schema";
import type { RecycleEntry } from "#shared/contracts";

export const RECYCLE_RETENTION = 30 * 86400000;

export const recycleExpiry = (deletedAt: string) =>
  new Date(Date.parse(deletedAt) + RECYCLE_RETENTION).toISOString();
const cutoff = (now: number) => new Date(now - RECYCLE_RETENTION).toISOString();

export async function recycleEntries(
  userId: string,
  now = Date.now(),
): Promise<RecycleEntry[]> {
  const [spaces, files] = await db.batch([
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
      .select({ canvas: canvases, workspace: workspaces })
      .from(canvases)
      .innerJoin(workspaces, eq(canvases.workspaceId, workspaces.id))
      .where(
        and(
          eq(workspaces.userId, userId),
          isNull(workspaces.deletedAt),
          eq(workspaces.deleting, 0),
          isNotNull(canvases.deletedAt),
          eq(canvases.purging, 0),
          gt(canvases.deletedAt, cutoff(now)),
        ),
      ),
  ]);

  return [
    ...spaces.map((row): RecycleEntry => ({
      kind: "workspace",
      id: row.id,
      name: row.name,
      deletedAt: row.deletedAt!,
      expiresAt: recycleExpiry(row.deletedAt!),
    })),
    ...files.map(({ canvas, workspace }): RecycleEntry => ({
      kind: "canvas",
      id: canvas.id,
      name: canvas.name,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      deletedAt: canvas.deletedAt!,
      expiresAt: recycleExpiry(canvas.deletedAt!),
    })),
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
  kind: RecycleEntry["kind"],
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
