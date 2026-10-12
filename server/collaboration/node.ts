import { db } from "@nuxthub/db";
import { and, eq, sql } from "drizzle-orm";
import { collaborationRooms } from "#server/db/schema";
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
