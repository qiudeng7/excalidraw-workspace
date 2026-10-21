import { moveCanvas } from "#server/db/canvas-move";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { requireCanvas } from "#server/utils/access";
import { body, fail, json, validRevision } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);
  const user = await requireUser(event);
  const source = await requireCanvas(id, user);
  const data = await body(apiRequest(event));
  const catalogRevision = validRevision(data.catalogRevision);

  if (
    typeof data.targetId !== "string" ||
    !data.targetId ||
    data.targetId === id ||
    (data.placement !== "before" && data.placement !== "after")
  ) {
    return fail(400, "INVALID_CANVAS_MOVE", "请选择其他画布及有效的移动位置");
  }

  const target = await requireCanvas(data.targetId, user);

  if (
    source.workspaceId !== target.workspaceId ||
    source.pinned !== target.pinned
  ) {
    return fail(
      400,
      "INVALID_CANVAS_MOVE",
      "只能在同一空间的置顶或未置顶分组内调整顺序",
    );
  }

  const result = await moveCanvas(id, source.workspaceId, user.id, {
    targetId: data.targetId,
    placement: data.placement,
    catalogRevision,
  });

  if (!result) {
    return fail(409, "CATALOG_CONFLICT", "列表已在其他页面更新，请重新排序");
  }

  return json(result);
});
