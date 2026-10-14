import { recycleEntries } from "#server/db/recycle-bin";
import { defineApiHandler } from "#server/utils/api";
import { requireUser } from "#server/utils/auth";
import { syncRecycleRooms } from "#server/utils/recycle-bin";
import { json } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const user = await requireUser(event);

  await syncRecycleRooms(
    event.context.cloudflare?.env?.CANVAS_ROOMS,
    undefined,
    undefined,
    (error) =>
      console.warn(
        "回收站恢复等待重试",
        error instanceof Error ? error.message : "unknown",
      ),
    user.id,
  );

  return json({ entries: await recycleEntries(user.id) });
});
