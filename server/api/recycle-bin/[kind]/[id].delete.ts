import { getRouterParam } from "h3";
import { markRecyclePurge } from "#server/db/recycle-bin";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { requireUser } from "#server/utils/auth";
import { purgeRecycleEntry } from "#server/utils/recycle-bin";
import { fail, json, body } from "#server/utils/http";
import { apiRequest } from "#server/utils/request";

export default defineApiHandler(async (event) => {
  const kind = getRouterParam(event, "kind");
  const id = resourceId(event);
  const user = await requireUser(event);
  const data = await body(apiRequest(event));

  if (data.confirm !== true)
    return fail(400, "CONFIRM_REQUIRED", "请确认彻底删除，此操作不可恢复");
  if (kind !== "canvas" && kind !== "workspace")
    return fail(404, "NOT_FOUND", "回收项目不存在");
  if (!(await markRecyclePurge(kind, id, user.id)))
    return fail(404, "NOT_FOUND", "回收项目不存在");
  await purgeRecycleEntry(
    kind,
    id,
    event.context.cloudflare?.env?.CANVAS_ROOMS,
  );

  return json({});
});
