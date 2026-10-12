import { canvasCatalog, reorderCanvases } from "#server/db/canvases";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { requireWorkspace } from "#server/utils/access";
import { fail, json, body, validRevision } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  const req = apiRequest(event);
  const user = await requireUser(event);

  await requireWorkspace(id, user);

  const data = await body(req);
  const revision = validRevision(data.catalogRevision);
  const ids = data.canvasIds;
  const catalog = await canvasCatalog(id, user.id);

  if (!catalog) return fail(404, "NOT_FOUND", "工作区不存在");
  if (catalog.catalogRevision !== revision)
    return fail(409, "CATALOG_CONFLICT", "列表已在其他页面更新，请重新排序");
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== "string") ||
    new Set(ids).size !== ids.length ||
    ids.length !== catalog.canvases.length ||
    ids.some((id) => !catalog.canvases.some((canvas) => canvas.id === id))
  )
    return fail(
      400,
      "INVALID_CANVAS_ORDER",
      "画布顺序必须包含该空间所有画布且不可重复",
    );
  if (!(await reorderCanvases(id, user.id, ids, revision)))
    return fail(409, "CATALOG_CONFLICT", "列表已在其他页面更新，请重新排序");

  return json(await canvasCatalog(id, user.id));
});
