import { blob } from "@nuxthub/blob";
import { getQuery } from "h3";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { fail, json } from "#server/utils/http";
import { canvasCommand } from "#server/collaboration/service";
import { referencedRoomObjects } from "#server/collaboration/garbage-collection";
import type { RoomBackup } from "#shared/collaboration/backup";

export default defineApiHandler(async (event) => {
  const backup = await canvasCommand<RoomBackup>(event, resourceId(event), {
    type: "backup",
  });
  const key = getQuery(event).object;

  if (key !== undefined) {
    if (
      typeof key !== "string" ||
      !referencedRoomObjects(backup.state).has(key)
    )
      return fail(403, "INVALID_BACKUP_OBJECT", "对象不属于此画布备份");
    const object = await blob.get(key);

    if (!object)
      return fail(
        503,
        "BACKUP_OBJECT_MISSING",
        "备份对象缺失，请重试或检查存储",
      );

    return new Response(await object.text(), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }

  return json(backup);
});
