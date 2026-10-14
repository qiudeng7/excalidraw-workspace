import { db } from "@nuxthub/db";
import { and, asc, eq, getTableColumns, inArray, isNull } from "drizzle-orm";
import * as tables from "#server/db/schema";
import type { Workspace } from "#shared/contracts";

const { userId: _owner, ...workspaceColumns } = getTableColumns(
  tables.workspaces,
);

export const ownedWorkspaceIds = (user: string) =>
  db
    .select({ id: tables.workspaces.id })
    .from(tables.workspaces)
    .where(
      and(
        eq(tables.workspaces.userId, user),
        eq(tables.workspaces.deleting, 0),
        isNull(tables.workspaces.deletedAt),
      ),
    );

export async function workspace(
  id: string,
  user: string,
): Promise<Workspace | null> {
  return (
    (
      await db
        .select(workspaceColumns)
        .from(tables.workspaces)
        .where(
          and(
            eq(tables.workspaces.id, id),
            eq(tables.workspaces.userId, user),
            eq(tables.workspaces.deleting, 0),
            isNull(tables.workspaces.deletedAt),
          ),
        )
    )[0] ?? null
  );
}

export async function workspaces(user: string): Promise<Workspace[]> {
  return db
    .select(workspaceColumns)
    .from(tables.workspaces)
    .where(
      and(
        eq(tables.workspaces.userId, user),
        eq(tables.workspaces.deleting, 0),
        isNull(tables.workspaces.deletedAt),
      ),
    )
    .orderBy(asc(tables.workspaces.createdAt), asc(tables.workspaces.id));
}

export async function createWorkspace(
  id: string,
  user: string,
  name: string,
  now: string,
) {
  await db
    .insert(tables.workspaces)
    .values({ id, userId: user, name, createdAt: now, updatedAt: now });
}

export async function renameWorkspace(
  id: string,
  user: string,
  name: string,
  now: string,
) {
  await db
    .update(tables.workspaces)
    .set({ name, updatedAt: now })
    .where(
      and(
        eq(tables.workspaces.id, id),
        eq(tables.workspaces.userId, user),
        eq(tables.workspaces.deleting, 0),
        isNull(tables.workspaces.deletedAt),
      ),
    );
}

export async function deleteWorkspace(id: string, user: string) {
  const result = await db.batch([
    db
      .delete(tables.canvases)
      .where(
        and(
          eq(tables.canvases.workspaceId, id),
          inArray(tables.canvases.workspaceId, ownedWorkspaceIds(user)),
        ),
      )
      .returning({ objectKey: tables.canvases.objectKey }),
    db
      .delete(tables.workspaces)
      .where(
        and(
          eq(tables.workspaces.id, id),
          eq(tables.workspaces.userId, user),
          eq(tables.workspaces.deleting, 0),
          isNull(tables.workspaces.deletedAt),
        ),
      ),
  ]);

  return result[0].flatMap((row) => (row.objectKey ? [row.objectKey] : []));
}
