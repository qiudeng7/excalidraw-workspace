import { getRouterParam } from "h3";
import { restoreRecycleEntry } from "#server/db/recycle-bin";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { requireUser } from "#server/utils/auth";
import { syncRecycleRooms } from "#server/utils/recycle-bin";
import { fail, json } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const kind = getRouterParam(event, "kind");
  const id = resourceId(event);
  const user = await requireUser(event);

  if (kind !== "canvas" && kind !== "workspace")
    return fail(404, "NOT_FOUND", "回收项目不存在");
  if (!(await restoreRecycleEntry(kind, id, user.id)))
    return fail(
      404,
      "RECYCLE_UNAVAILABLE",
      "回收项目不存在、已过期，或需要先恢复工作空间",
    );
  await syncRecycleRooms(
    event.context.cloudflare?.env?.CANVAS_ROOMS,
    kind === "workspace" ? id : undefined,
    kind === "canvas" ? id : undefined,
  );

  return json({});
});
