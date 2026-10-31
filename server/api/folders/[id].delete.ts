import { recycleFolderTree, ownedFolderLocation } from "#server/db/directory";
import { requireUser } from "#server/utils/auth";
import { syncRecycleRooms } from "#server/utils/recycle-bin";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { body, fail, json, validRevision } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);
  const user = await requireUser(event);
  const location = await ownedFolderLocation(id, user.id);

  if (!location) return fail(404, "NOT_FOUND", "文件夹不存在");
  const data = await body(apiRequest(event));
  const revision = validRevision(data.catalogRevision);

  if (revision !== location.catalogRevision)
    return fail(409, "CATALOG_CONFLICT", "目录已更新，请重新加载");

  const result = await recycleFolderTree(
    id,
    location.workspaceId,
    user.id,
    revision,
  );

  if (!result) return fail(409, "CATALOG_CONFLICT", "目录已更新，请重新加载");

  const namespace = event.context.cloudflare?.env?.CANVAS_ROOMS;

  for (const canvasId of result.affectedCanvasIds)
    await syncRecycleRooms(namespace, undefined, canvasId);

  return json(result);
});
