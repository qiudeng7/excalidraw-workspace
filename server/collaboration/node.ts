import { db } from "@nuxthub/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { collaborationRooms, canvases, workspaces } from "#server/db/schema";
import { execute, type Command } from "#shared/collaboration/room";
import { reject } from "#shared/collaboration/merge";
import type { Principal, RoomState } from "#shared/collaboration/types";

export const roomListeners = new Map<
  string,
  Set<(command: Command, result: unknown) => void>
>();

/** CAS guards asynchronous interleaving and accidental second Node processes. */
export async function nodeCommand(
  id: string,
  principal: Principal,
  command: Command,
  seed?: RoomState,
): Promise<unknown> {
  if (
    !["recycle", "delete", "projection", "projectionAck"].includes(command.type)
  ) {
    const active = await db
      .select({ id: canvases.id, pending: canvases.recyclePending })
      .from(canvases)
      .innerJoin(workspaces, eq(canvases.workspaceId, workspaces.id))
      .where(
        and(
          eq(canvases.id, id),
          isNull(canvases.deletedAt),
          isNull(workspaces.deletedAt),
          eq(canvases.purging, 0),
          eq(workspaces.deleting, 0),
        ),
      )
      .limit(1);

    if (!active.length)
      reject("CANVAS_DELETED", "画布已移入回收站或彻底删除", 410);
    if (active[0]!.pending)
      reject("RECYCLE_SYNC_PENDING", "正在恢复画布，请稍后重试", 503);
  }

  if (seed)
    await db
      .insert(collaborationRooms)
      .values({ id, state: JSON.stringify(seed) })
      .onConflictDoNothing();
  for (let attempt = 0; attempt < 30; attempt++) {
    const row = (
      await db
        .select()
        .from(collaborationRooms)
        .where(eq(collaborationRooms.id, id))
    )[0];

    if (!row) reject("ROOM_NOT_FOUND", "协作房间尚未初始化", 404);
    const room = JSON.parse(row.state) as RoomState;
    const result = execute(room, principal, command, Date.now());

    if (
      ["access", "view", "manage", "backup", "projection"].includes(
        command.type,
      )
    )
      return result;
    const state = JSON.stringify(room);

    if (state === row.state) return result;
    const changed = await db
      .update(collaborationRooms)
      .set({ state, generation: sql`${collaborationRooms.generation}+1` })
      .where(
        and(
          eq(collaborationRooms.id, id),
          eq(collaborationRooms.generation, row.generation),
        ),
      )
      .returning({ id: collaborationRooms.id });

    if (changed.length) {
      for (const listener of roomListeners.get(id) ?? [])
        listener(command, result);

      return result;
    }
  }

  return reject("ROOM_BUSY", "画布更新繁忙，请稍后重试", 503);
}
