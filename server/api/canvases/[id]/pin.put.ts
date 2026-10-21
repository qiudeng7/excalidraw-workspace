import { canvasCatalog, setCanvasPinned } from "#server/db/canvases";
import { canvasPinSummary } from "#server/db/canvas-catalog";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { requireCanvas } from "#server/utils/access";
import { body, fail, json, validRevision } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);
  const user = await requireUser(event);
  const canvas = await requireCanvas(id, user);
  const data = await body(apiRequest(event));

  if (typeof data.pinned !== "boolean") {
    return fail(400, "INVALID_PIN_STATE", "置顶状态必须为布尔值");
  }

  const revision = validRevision(data.catalogRevision);

  if (
    !(await setCanvasPinned(
      id,
      user.id,
      canvas.workspaceId,
      data.pinned,
      revision,
    ))
  ) {
    return fail(409, "CATALOG_CONFLICT", "列表已在其他页面更新，请重新操作");
  }

  if (new URL(apiRequest(event).url).searchParams.get("return") === "summary") {
    return json(await canvasPinSummary(canvas.workspaceId, user.id, id));
  }

  const catalog = await canvasCatalog(canvas.workspaceId, user.id);

  if (!catalog) return fail(404, "NOT_FOUND", "工作区不存在");

  return json(catalog);
});
