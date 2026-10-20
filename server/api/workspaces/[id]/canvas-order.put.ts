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
  const byId = new Map(catalog.canvases.map((canvas) => [canvas.id, canvas]));
  const pinnedCount = catalog.canvases.filter((canvas) => canvas.pinned).length;

  if (
    ids.some(
      (canvasId, index) => !!byId.get(canvasId)!.pinned !== index < pinnedCount,
    )
  ) {
    return fail(
      400,
      "INVALID_CANVAS_ORDER",
      "只能在置顶或未置顶分组内调整顺序",
    );
  }

  // Preserve each group's original slots, including after pinning interleaved files.
  // Normalize tied positions (possible after restore) using the canonical ID tie-break.
  const base = [...catalog.canvases].sort(
    (a, b) =>
      a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const pinnedIds = ids.slice(0, pinnedCount);
  const unpinnedIds = ids.slice(pinnedCount);
  let pinnedIndex = 0;
  let unpinnedIndex = 0;
  const baseIds = base.map((canvas) =>
    canvas.pinned ? pinnedIds[pinnedIndex++]! : unpinnedIds[unpinnedIndex++]!,
  );

  if (!(await reorderCanvases(id, user.id, baseIds, revision)))
    return fail(409, "CATALOG_CONFLICT", "列表已在其他页面更新，请重新排序");

  const updated = await canvasCatalog(id, user.id);

  if (!updated) return fail(404, "NOT_FOUND", "工作区不存在");

  return json(updated);
});
