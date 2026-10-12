import { db } from "@nuxthub/db";
import { and, asc, eq, exists, getTableColumns, sql } from "drizzle-orm";
import * as tables from "#server/db/schema";
import type { Navigation } from "#shared/contracts";

export async function navigation(user: string): Promise<Navigation> {
  const { userId: _user, ...columns } = getTableColumns(tables.userNavigation);
  const result = await db.batch([
    db
      .select(columns)
      .from(tables.userNavigation)
      .where(eq(tables.userNavigation.userId, user)),
    db
      .select({
        workspaceId: tables.workspaceNavigation.workspaceId,
        lastCanvasId: tables.workspaceNavigation.lastCanvasId,
      })
      .from(tables.workspaceNavigation)
      .where(eq(tables.workspaceNavigation.userId, user))
      .orderBy(asc(tables.workspaceNavigation.workspaceId)),
  ]);

  if (!result[0][0]) throw new Error("Navigation row missing");

  return { ...result[0][0], workspaces: result[1] };
}

export async function recordNavigation(
  user: string,
  canvas: string,
  revision: number,
) {
  const result = await db.batch([
    db
      .insert(tables.workspaceNavigation)
      .select(
        db
          .select({
            userId: tables.workspaces.userId,
            workspaceId: tables.canvases.workspaceId,
            lastCanvasId: tables.canvases.id,
          })
          .from(tables.canvases)
          .innerJoin(
            tables.workspaces,
            eq(tables.workspaces.id, tables.canvases.workspaceId),
          )
          .innerJoin(
            tables.userNavigation,
            eq(tables.userNavigation.userId, tables.workspaces.userId),
          )
          .where(
            and(
              eq(tables.canvases.id, canvas),
              eq(tables.workspaces.userId, user),
              eq(tables.userNavigation.revision, revision),
            ),
          ),
      )
      .onConflictDoUpdate({
        target: [
          tables.workspaceNavigation.userId,
          tables.workspaceNavigation.workspaceId,
        ],
        set: { lastCanvasId: sql`excluded.last_canvas_id` },
      }),
    db
      .update(tables.userNavigation)
      .set({
        lastWorkspaceId: sql`(SELECT ${tables.canvases.workspaceId} FROM ${tables.canvases} WHERE ${tables.canvases.id}=${canvas})`,
        lastCanvasId: canvas,
        revision: sql`${tables.userNavigation.revision}+1`,
      })
      .where(
        and(
          eq(tables.userNavigation.userId, user),
          eq(tables.userNavigation.revision, revision),
          exists(
            db
              .select({ id: tables.canvases.id })
              .from(tables.canvases)
              .innerJoin(
                tables.workspaces,
                eq(tables.workspaces.id, tables.canvases.workspaceId),
              )
              .where(
                and(
                  eq(tables.canvases.id, canvas),
                  eq(tables.workspaces.userId, user),
                ),
              ),
          ),
        ),
      )
      .returning({ revision: tables.userNavigation.revision }),
  ]);

  return result[1].length;
}
