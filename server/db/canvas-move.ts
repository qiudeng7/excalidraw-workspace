import { db } from "@nuxthub/db";
import { and, eq, exists, isNull, sql } from "drizzle-orm";
import * as tables from "#server/db/schema";
import type { CanvasMove } from "#shared/contracts";

/** Preserve each pin group's base slots, including ties left by recycle-bin restores.
 * Materialize the mapping before UPDATE so SQLite never reads positions it just wrote.
 * A fixed-size batch avoids both full catalog responses and D1's bound-parameter limit.
 */
export const moveCanvas = async (
  id: string,
  workspace: string,
  user: string,
  move: CanvasMove,
) => {
  const available = sql`EXISTS (
    SELECT 1 FROM canvases source JOIN canvases target ON source.workspace_id = target.workspace_id AND source.pinned = target.pinned
    WHERE source.id = ${id} AND target.id = ${move.targetId}
      AND source.workspace_id = ${workspace} AND source.deleted_at IS NULL AND target.deleted_at IS NULL
  )`;
  const matching = and(
    eq(tables.workspaces.id, workspace),
    eq(tables.workspaces.userId, user),
    eq(tables.workspaces.deleting, 0),
    isNull(tables.workspaces.deletedAt),
    eq(tables.workspaces.catalogRevision, move.catalogRevision),
    available,
  );
  const mapping = db.$with("move_mapping", {}).as(sql`
      WITH slots AS MATERIALIZED (
        SELECT id, pinned,
          row_number() OVER (ORDER BY position, id) - 1 AS base_position,
          row_number() OVER (PARTITION BY pinned ORDER BY position, id) - 1 AS group_position
        FROM canvases WHERE workspace_id = ${workspace} AND deleted_at IS NULL
      ), bounds AS (
        SELECT source.group_position AS source_position,
          target.group_position - (source.group_position < target.group_position) + ${move.placement === "after" ? 1 : 0} AS destination,
          source.pinned
        FROM slots source JOIN slots target ON source.pinned = target.pinned
        WHERE source.id = ${id} AND target.id = ${move.targetId}
      ), moved AS (
        SELECT slots.id, slots.pinned,
          CASE WHEN slots.id = ${id} THEN bounds.destination
            WHEN bounds.source_position < bounds.destination AND slots.group_position > bounds.source_position AND slots.group_position <= bounds.destination THEN slots.group_position - 1
            WHEN bounds.source_position > bounds.destination AND slots.group_position >= bounds.destination AND slots.group_position < bounds.source_position THEN slots.group_position + 1
            ELSE slots.group_position END AS destination
        FROM slots CROSS JOIN bounds WHERE slots.pinned = bounds.pinned
      ), mapping AS MATERIALIZED (
        SELECT moved.id, slots.base_position FROM moved JOIN slots ON moved.pinned = slots.pinned AND moved.destination = slots.group_position
        UNION ALL SELECT slots.id, slots.base_position FROM slots CROSS JOIN bounds WHERE slots.pinned <> bounds.pinned
      )
      SELECT id, base_position FROM mapping
    `);
  const [_, revisions] = await db.batch([
    db
      .with(mapping)
      .update(tables.canvases)
      .set({
        position: sql`(SELECT base_position FROM ${mapping} WHERE move_mapping.id = ${tables.canvases.id})`,
      })
      .where(
        and(
          sql`${tables.canvases.id} IN (SELECT id FROM ${mapping})`,
          exists(
            db
              .select({ id: tables.workspaces.id })
              .from(tables.workspaces)
              .where(matching),
          ),
        ),
      ),
    db
      .update(tables.workspaces)
      .set({ catalogRevision: sql`${tables.workspaces.catalogRevision} + 1` })
      .where(matching)
      .returning({ catalogRevision: tables.workspaces.catalogRevision }),
  ]);

  return revisions[0];
};
