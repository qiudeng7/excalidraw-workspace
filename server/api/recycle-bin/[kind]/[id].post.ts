import { getRouterParam } from "h3";
import { restoreRecycleEntry } from "#server/db/recycle-bin";
import {
  restoreDirectoryCanvas,
  restoreDirectoryFolder,
} from "#server/db/directory-restore";
import type { RestoreDirectoryRequest } from "#shared/directory-contracts";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { syncRecycleRooms } from "#server/utils/recycle-bin";
import { body, fail, json } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const kind = getRouterParam(event, "kind");
  const id = resourceId(event);
  const user = await requireUser(event);
  const req = apiRequest(event);
  const data = req.body ? await body(req) : {};
  const parentId = data.parentId;

  if (
    parentId !== undefined &&
    parentId !== null &&
    typeof parentId !== "string"
  )
    return fail(400, "INVALID_DIRECTORY_PARENT", "恢复位置无效");
  const request: RestoreDirectoryRequest = {
    parentId: parentId as string | null | undefined,
  };
  const namespace = event.context.cloudflare?.env?.CANVAS_ROOMS;

  if (kind === "folder") {
    const restored = await restoreDirectoryFolder(id, user.id, request);

    if (!restored)
      return fail(404, "RECYCLE_UNAVAILABLE", "回收项目不存在或已过期");
    for (const canvasId of restored.restoredCanvasIds)
      await syncRecycleRooms(namespace, undefined, canvasId);

    return json(restored);
  }

  if (kind === "canvas") {
    const restored = await restoreDirectoryCanvas(id, user.id, request);

    if (!restored)
      return fail(
        404,
        "RECYCLE_UNAVAILABLE",
        "回收项目不存在、已过期，或需要先恢复工作空间",
      );
    await syncRecycleRooms(namespace, undefined, id);

    return json(restored);
  }

  if (kind !== "workspace") return fail(404, "NOT_FOUND", "回收项目不存在");
  if (!(await restoreRecycleEntry("workspace", id, user.id)))
    return fail(404, "RECYCLE_UNAVAILABLE", "回收项目不存在或已过期");
  await syncRecycleRooms(namespace, id);

  return json({});
});
