import { undoDirectorySelection } from "#server/db/directory-batch";
import { requireUser } from "#server/utils/auth";
import { requireWorkspace } from "#server/utils/access";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { body, fail, json } from "#server/utils/http";
import { batchUndoDirectoryRequest } from "#server/utils/directory-batch";
import { syncRecycleRooms } from "#server/utils/recycle-bin";

export default defineApiHandler(async (event) => {
  const workspaceId = resourceId(event);
  const user = await requireUser(event);

  await requireWorkspace(workspaceId, user);
  const request = batchUndoDirectoryRequest(await body(apiRequest(event)));
  const result = await undoDirectorySelection(workspaceId, user.id, request);

  if (!result) return fail(404, "NOT_FOUND", "工作区不存在");
  if (result.kind === "delete") {
    const namespace = event.context.cloudflare?.env?.CANVAS_ROOMS;

    try {
      await syncRecycleRooms(
        namespace,
        workspaceId,
        undefined,
        (error) => console.error("Failed to sync restored canvas room", error),
        user.id,
      );
    } catch (error) {
      console.error("Failed to sync restored canvas rooms", error);
    }
  }

  return json(result);
});
