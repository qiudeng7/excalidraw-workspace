import { db } from "@nuxthub/db";
import {
  and,
  asc,
  eq,
  exists,
  getTableColumns,
  inArray,
  sql,
} from "drizzle-orm";
import * as tables from "./schema";
import { ownedWorkspaceIds } from "./workspaces";

const { objectKey: _object, ...canvasColumns } = getTableColumns(
  tables.canvases,
);

export async function canvas(id: string, user: string) {
  return (
    (
      await db
        .select(getTableColumns(tables.canvases))
        .from(tables.canvases)
        .where(
          and(
            eq(tables.canvases.id, id),
            inArray(tables.canvases.workspaceId, ownedWorkspaceIds(user)),
          ),
        )
    )[0] ?? null
  );
}

/** Position shifts, insertion and catalog CAS form one native atomic batch. */

export async function createCanvas(
  id: string,
  workspace: string,
  user: string,
  name: string,
  now: string,
  catalogRevision: number,
) {
  const result = await db.batch([
    db
      .update(tables.canvases)
      .set({ position: sql`${tables.canvases.position}+1` })
      .where(
        and(
          eq(tables.canvases.workspaceId, workspace),
          catalogMatches(workspace, user, catalogRevision),
        ),
      ),
    db.insert(tables.canvases).select(
      db
        .select({
          id: sql<string>`${id}`.as("id"),
          workspaceId: tables.workspaces.id,
          name: sql<string>`${name}`.as("name"),
          revision: sql<number>`0`.as("revision"),
          objectKey: sql<string | null>`NULL`.as("objectKey"),
          createdAt: sql<string>`${now}`.as("createdAt"),
          updatedAt: sql<string>`${now}`.as("updatedAt"),
          position: sql<number>`0`.as("position"),
        })
        .from(tables.workspaces)
        .where(
          and(
            eq(tables.workspaces.id, workspace),
            eq(tables.workspaces.userId, user),
            eq(tables.workspaces.catalogRevision, catalogRevision),
          ),
        ),
    ),
    db
      .update(tables.workspaces)
      .set({ catalogRevision: sql`${tables.workspaces.catalogRevision}+1` })
      .where(
        and(
          eq(tables.workspaces.id, workspace),
          eq(tables.workspaces.userId, user),
          eq(tables.workspaces.catalogRevision, catalogRevision),
        ),
      )
      .returning({ id: tables.workspaces.id }),
  ]);

  return result[2].length;
}

export async function renameCanvas(
  id: string,
  user: string,
  name: string,
  now: string,
) {
  await db
    .update(tables.canvases)
    .set({ name, updatedAt: now })
    .where(
      and(
        eq(tables.canvases.id, id),
        inArray(tables.canvases.workspaceId, ownedWorkspaceIds(user)),
      ),
    );
}

export async function deleteCanvas(
  id: string,
  user: string,
  workspace: string,
  catalogRevision: number,
) {
  const result = await db.batch([
    db
      .delete(tables.canvases)
      .where(
        and(
          eq(tables.canvases.id, id),
          eq(tables.canvases.workspaceId, workspace),
          catalogMatches(workspace, user, catalogRevision),
        ),
      )
      .returning({ objectKey: tables.canvases.objectKey }),
    db
      .update(tables.workspaces)
      .set({ catalogRevision: sql`${tables.workspaces.catalogRevision}+1` })
      .where(
        and(
          eq(tables.workspaces.id, workspace),
          eq(tables.workspaces.userId, user),
          eq(tables.workspaces.catalogRevision, catalogRevision),
        ),
      )
      .returning({ id: tables.workspaces.id }),
  ]);

  return { changed: result[1].length, objectKey: result[0][0]?.objectKey };
}

export async function reorderCanvases(
  workspace: string,
  user: string,
  ids: string[],
  revision: number,
) {
  const [first, ...rest] = ids.map((id, position) =>
    db
      .update(tables.canvases)
      .set({ position })
      .where(
        and(
          eq(tables.canvases.id, id),
          eq(tables.canvases.workspaceId, workspace),
          catalogMatches(workspace, user, revision),
        ),
      )
      .returning({ id: tables.canvases.id }),
  );
  const updateRevision = db
    .update(tables.workspaces)
    .set({ catalogRevision: sql`${tables.workspaces.catalogRevision}+1` })
    .where(
      and(
        eq(tables.workspaces.id, workspace),
        eq(tables.workspaces.userId, user),
        eq(tables.workspaces.catalogRevision, revision),
      ),
    )
    .returning({ id: tables.workspaces.id });
  const result = await db.batch(
    first ? [first, ...rest, updateRevision] : [updateRevision],
  );

  return result[result.length - 1]!.length;
}

export async function canvasCatalog(workspace: string, user: string) {
  const result = await db.batch([
    db
      .select({ catalogRevision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(
        and(
          eq(tables.workspaces.id, workspace),
          eq(tables.workspaces.userId, user),
        ),
      ),
    db
      .select(canvasColumns)
      .from(tables.canvases)
      .where(
        and(
          eq(tables.canvases.workspaceId, workspace),
          inArray(tables.canvases.workspaceId, ownedWorkspaceIds(user)),
        ),
      )
      .orderBy(asc(tables.canvases.position), asc(tables.canvases.id)),
  ]);

  return result[0][0]
    ? { catalogRevision: result[0][0].catalogRevision, canvases: result[1] }
    : null;
}

function catalogMatches(workspace: string, user: string, revision: number) {
  return exists(
    db
      .select({ id: tables.workspaces.id })
      .from(tables.workspaces)
      .where(
        and(
          eq(tables.workspaces.id, workspace),
          eq(tables.workspaces.userId, user),
          eq(tables.workspaces.catalogRevision, revision),
        ),
      ),
  );
}
