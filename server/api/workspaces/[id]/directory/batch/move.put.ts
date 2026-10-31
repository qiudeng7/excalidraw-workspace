import { moveDirectorySelection } from "#server/db/directory-batch";
import { requireUser } from "#server/utils/auth";
import { requireWorkspace } from "#server/utils/access";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { body, fail, json } from "#server/utils/http";
import { batchMoveDirectoryRequest } from "#server/utils/directory-batch";

export default defineApiHandler(async (event) => {
  const workspaceId = resourceId(event);
  const user = await requireUser(event);

  await requireWorkspace(workspaceId, user);
  const request = batchMoveDirectoryRequest(await body(apiRequest(event)));
  const result = await moveDirectorySelection(workspaceId, user.id, request);

  if (!result) return fail(404, "NOT_FOUND", "工作区不存在");

  return json(result);
});
