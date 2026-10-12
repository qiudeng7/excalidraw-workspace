import { createCanvas } from "#server/db/canvases";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { requireWorkspace, requireCanvas } from "#server/utils/access";
import { meta } from "#server/utils/snapshots";
import { fail, json, body, name, validRevision } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  const req = apiRequest(event);
  const user = await requireUser(event);
  const ws = await requireWorkspace(id, user);

  const data = await body(req);
  const canvasId = crypto.randomUUID();
  const now = new Date().toISOString();
  const revision = validRevision(data.catalogRevision ?? ws.catalogRevision);
  const changed = await createCanvas(
    canvasId,
    id,
    user.id,
    name(data.name, "未命名画布"),
    now,
    revision,
  );

  if (!changed)
    return fail(409, "CATALOG_CONFLICT", "列表已在其他页面更新，请重新加载");

  return json({
    canvas: meta(await requireCanvas(canvasId, user)),
    catalogRevision: revision + 1,
  });
});
