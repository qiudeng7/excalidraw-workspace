import { db } from "@nuxthub/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as tables from "./schema";
import { ownedWorkspaceIds } from "./workspaces";

export async function library(user: string) {
  return (
    (
      await db
        .select({
          revision: tables.libraries.revision,
          objectKey: tables.libraries.objectKey,
        })
        .from(tables.libraries)
        .where(eq(tables.libraries.userId, user))
    )[0] ?? null
  );
}

export async function publishSnapshot(
  type: "canvas" | "library",
  id: string,
  user: string,
  key: string,
  revision: number,
  now: string,
) {
  const rows =
    type === "canvas"
      ? await db
          .update(tables.canvases)
          .set({
            objectKey: key,
            revision: sql`${tables.canvases.revision}+1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(tables.canvases.id, id),
              eq(tables.canvases.revision, revision),
              eq(tables.canvases.syncMode, "legacy"),
              inArray(tables.canvases.workspaceId, ownedWorkspaceIds(user)),
            ),
          )
          .returning({ revision: tables.canvases.revision })
      : await db
          .update(tables.libraries)
          .set({
            objectKey: key,
            revision: sql`${tables.libraries.revision}+1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(tables.libraries.userId, user),
              eq(tables.libraries.revision, revision),
            ),
          )
          .returning({ revision: tables.libraries.revision });

  return rows.length;
}

/** Two indexed queries per batch, independent of the number of stored objects. */
export async function referencedObjects(keys: string[]) {
  if (!keys.length) return new Set<string>();
  const rows = await db.batch([
    db
      .select({ key: tables.canvases.objectKey })
      .from(tables.canvases)
      .where(inArray(tables.canvases.objectKey, keys)),
    db
      .select({ key: tables.libraries.objectKey })
      .from(tables.libraries)
      .where(inArray(tables.libraries.objectKey, keys)),
  ]);

  return new Set(rows.flat().flatMap((row) => (row.key ? [row.key] : [])));
}
