import { recycleWorkspace } from "#server/db/recycle-bin";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { requireUser } from "#server/utils/auth";
import { requireWorkspace } from "#server/utils/access";
import { syncRecycleRooms } from "#server/utils/recycle-bin";
import { json } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);
  const user = await requireUser(event);

  await requireWorkspace(id, user);
  await recycleWorkspace(id, user.id);
  await syncRecycleRooms(event.context.cloudflare?.env?.CANVAS_ROOMS, id);

  return json({});
});
