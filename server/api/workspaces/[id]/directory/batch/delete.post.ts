import { deleteDirectorySelection } from "#server/db/directory-batch";
import { requireUser } from "#server/utils/auth";
import { requireWorkspace } from "#server/utils/access";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { body, fail, json } from "#server/utils/http";
import { batchDirectoryRequest } from "#server/utils/directory-batch";
import { syncRecycleRooms } from "#server/utils/recycle-bin";

export default defineApiHandler(async (event) => {
  const workspaceId = resourceId(event);
  const user = await requireUser(event);

  await requireWorkspace(workspaceId, user);
  const request = batchDirectoryRequest(await body(apiRequest(event)));
  const result = await deleteDirectorySelection(
    workspaceId,
    user.id,
    request.sources,
    request.catalogRevision,
  );

  if (!result) return fail(404, "NOT_FOUND", "工作区不存在");
  const namespace = event.context.cloudflare?.env?.CANVAS_ROOMS;

  try {
    await syncRecycleRooms(
      namespace,
      workspaceId,
      undefined,
      (error) => console.error("Failed to sync recycled canvas room", error),
      user.id,
    );
  } catch (error) {
    console.error("Failed to sync recycled canvas rooms", error);
  }

  return json(result);
});
