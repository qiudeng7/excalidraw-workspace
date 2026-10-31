import { folderSummary, ownedFolderLocation } from "#server/db/directory";
import { requireUser } from "#server/utils/auth";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { fail, json } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);
  const user = await requireUser(event);
  const location = await ownedFolderLocation(id, user.id);

  if (!location) return fail(404, "NOT_FOUND", "文件夹不存在");
  const summary = await folderSummary(id, location.workspaceId, user.id);

  if (!summary) return fail(404, "NOT_FOUND", "文件夹不存在");

  return json(summary);
});
