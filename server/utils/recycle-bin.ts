import { db } from "@nuxthub/db";
import { and, asc, eq, gt, inArray, isNotNull, lte, or } from "drizzle-orm";
import { canvases, workspaces } from "#server/db/schema";
import { markRecyclePurge, RECYCLE_RETENTION } from "#server/db/recycle-bin";
import {
  dispatchRoomCommand,
  type RoomNamespace,
} from "#server/collaboration/transport";
import { projectNodeRoom } from "#server/collaboration/node-projection";
import { deleteSnapshots } from "#server/utils/snapshots";
import { buildRoomSeed } from "#server/collaboration/service";
import { ApiError } from "#server/utils/http";
import type { RecycleEntry } from "#shared/contracts";

async function rows(
  workspaceId?: string,
  canvasId?: string,
  after = "",
  userId?: string,
) {
  return db
    .select({ canvas: canvases, workspace: workspaces })
    .from(canvases)
    .innerJoin(workspaces, eq(canvases.workspaceId, workspaces.id))
    .where(
      and(
        workspaceId ? eq(workspaces.id, workspaceId) : undefined,
        userId ? eq(workspaces.userId, userId) : undefined,
        canvasId ? eq(canvases.id, canvasId) : undefined,
        gt(canvases.id, after),
        eq(canvases.recyclePending, 1),
        eq(canvases.purging, 0),
        eq(workspaces.deleting, 0),
      ),
    )
    .orderBy(asc(canvases.id))
    .limit(100);
}

/** Persistent metadata outbox + monotonic revision makes partial failures retryable. */
export async function syncRecycleRooms(
  namespace?: RoomNamespace,
  workspaceId?: string,
  canvasId?: string,
  onError?: (error: unknown) => void,
  userId?: string,
) {
  let after = "";

  for (;;) {
    const page = await rows(workspaceId, canvasId, after, userId);

    if (!page.length) return;
    after = page.at(-1)!.canvas.id;
    for (const { canvas, workspace } of page) {
      try {
        if (canvas.syncMode !== "legacy") {
          const deletedAt =
            [canvas.deletedAt, workspace.deletedAt]
              .filter((value): value is string => !!value)
              .sort()[0] ?? null;

          const seed =
            canvas.syncMode === "preparing"
              ? await buildRoomSeed({ canvas, ownerId: workspace.userId })
              : undefined;

          await dispatchRoomCommand(
            namespace,
            canvas.id,
            { userId: workspace.userId, name: "" },
            {
              type: "recycle",
              deletedAt,
              revision: canvas.recycleRevision,
              epoch: crypto.randomUUID(),
            },
            seed,
          );
          if (!namespace) await projectNodeRoom(canvas.id);
          if (seed)
            await db
              .update(canvases)
              .set({ syncMode: "collaborative" })
              .where(
                and(
                  eq(canvases.id, canvas.id),
                  eq(canvases.syncMode, "preparing"),
                  eq(canvases.recycleRevision, canvas.recycleRevision),
                ),
              );
        }

        await db
          .update(canvases)
          .set({ recyclePending: 0 })
          .where(
            and(
              eq(canvases.id, canvas.id),
              eq(canvases.recycleRevision, canvas.recycleRevision),
            ),
          );
      } catch (error) {
        if (!onError) throw error;
        onError(error);
      }
    }
  }
}

export async function purgeRecycleEntry(
  kind: RecycleEntry["kind"],
  id: string,
  namespace?: RoomNamespace,
) {
  const targets = await db
    .select({ canvas: canvases, ownerId: workspaces.userId })
    .from(canvases)
    .innerJoin(workspaces, eq(canvases.workspaceId, workspaces.id))
    .where(
      kind === "workspace"
        ? and(eq(workspaces.id, id), eq(workspaces.deleting, 1))
        : and(eq(canvases.id, id), eq(canvases.purging, 1)),
    );

  for (const { canvas, ownerId } of targets) {
    if (canvas.syncMode !== "legacy") {
      try {
        await dispatchRoomCommand(
          namespace,
          canvas.id,
          { userId: ownerId, name: "" },
          { type: "delete" },
        );
        if (!namespace) await projectNodeRoom(canvas.id);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "ROOM_NOT_FOUND")
          throw error;
      }
    }
  }

  // A room failure leaves the intent and catalog intact for the next retry.
  const keys = targets.flatMap(({ canvas }) =>
    canvas.objectKey ? [canvas.objectKey] : [],
  );

  if (kind === "workspace")
    await db.batch([
      db.delete(canvases).where(
        inArray(
          canvases.workspaceId,
          db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(and(eq(workspaces.id, id), eq(workspaces.deleting, 1))),
        ),
      ),
      db
        .delete(workspaces)
        .where(and(eq(workspaces.id, id), eq(workspaces.deleting, 1))),
    ]);
  else
    await db
      .delete(canvases)
      .where(and(eq(canvases.id, id), eq(canvases.purging, 1)));
  if (keys.length) await deleteSnapshots(keys);
}

export async function collectRecycleBin(
  namespace?: RoomNamespace,
  now = Date.now(),
) {
  const errors: unknown[] = [];
  const recordError = (error: unknown) => errors.push(error);

  await syncRecycleRooms(namespace, undefined, undefined, recordError);
  const deadline = new Date(now - RECYCLE_RETENTION).toISOString();

  for (const kind of ["workspace", "canvas"] as const) {
    let after = "";

    for (;;) {
      const page =
        kind === "workspace"
          ? await db
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(
                and(
                  gt(workspaces.id, after),
                  isNotNull(workspaces.deletedAt),
                  or(
                    eq(workspaces.deleting, 1),
                    lte(workspaces.deletedAt, deadline),
                  ),
                ),
              )
              .orderBy(asc(workspaces.id))
              .limit(100)
          : await db
              .select({ id: canvases.id })
              .from(canvases)
              .where(
                and(
                  gt(canvases.id, after),
                  isNotNull(canvases.deletedAt),
                  or(
                    eq(canvases.purging, 1),
                    lte(canvases.deletedAt, deadline),
                  ),
                ),
              )
              .orderBy(asc(canvases.id))
              .limit(100);

      if (!page.length) break;
      after = page.at(-1)!.id;
      for (const row of page) {
        try {
          if (await markRecyclePurge(kind, row.id, undefined, now))
            await purgeRecycleEntry(kind, row.id, namespace);
        } catch (error) {
          recordError(error);
        }
      }
    }
  }

  if (errors.length)
    throw new AggregateError(errors, "部分回收项目等待下次重试");
}
