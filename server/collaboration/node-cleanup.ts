import { blob } from "@nuxthub/blob";
import { db } from "@nuxthub/db";
import { asc, gt } from "drizzle-orm";
import { collaborationRooms } from "#server/db/schema";
import type { RoomState } from "#shared/collaboration/types";
import {
  referencedRoomObjects,
  ROOM_OBJECT_GRACE,
} from "#server/collaboration/garbage-collection";

export async function collectNodeRoomOrphans(now = Date.now()) {
  let after = "";

  for (;;) {
    const rows = await db
      .select()
      .from(collaborationRooms)
      .where(gt(collaborationRooms.id, after))
      .orderBy(asc(collaborationRooms.id))
      .limit(10);

    if (!rows.length) return;
    for (const row of rows) {
      const room = JSON.parse(row.state) as RoomState;
      const referenced = referencedRoomObjects(room);
      let cursor: string | undefined;

      do {
        const page = await blob.list({
          prefix: `collaboration/${room.id}/`,
          cursor,
          limit: 100,
        });
        const orphans = page.blobs
          .filter(
            (object) =>
              !referenced.has(object.pathname) &&
              new Date(object.uploadedAt).getTime() < now - ROOM_OBJECT_GRACE,
          )
          .map((object) => object.pathname);

        if (orphans.length) await blob.del(orphans);
        cursor = page.hasMore ? page.cursor : undefined;
        if (page.hasMore && !cursor)
          throw new Error("Missing room blob cursor");
      } while (cursor);

      after = row.id;
    }
  }
}
