import { recycleCanvas } from "#server/db/recycle-bin";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { requireWorkspace, requireCanvas } from "#server/utils/access";
import { syncRecycleRooms } from "#server/utils/recycle-bin";
import { fail, json, body, validRevision } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);
  const req = apiRequest(event);
  const user = await requireUser(event);
  const row = await requireCanvas(id, user);
  const workspace = await requireWorkspace(row.workspaceId, user);
  const data = req.body ? await body(req) : {};
  const revision = validRevision(
    data.catalogRevision ?? workspace.catalogRevision,
  );

  if (!(await recycleCanvas(id, user.id, row.workspaceId, revision)))
    return fail(409, "CATALOG_CONFLICT", "列表已在其他页面更新，请重新加载");
  await syncRecycleRooms(
    event.context.cloudflare?.env?.CANVAS_ROOMS,
    undefined,
    id,
  );

  return json({ catalogRevision: revision + 1 });
});
