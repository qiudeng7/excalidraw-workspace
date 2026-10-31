import { directoryPage } from "#server/db/directory";
import { catalogPageRequest } from "#server/db/canvas-catalog";
import { requireUser } from "#server/utils/auth";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { fail, json } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const workspaceId = resourceId(event);
  const user = await requireUser(event);
  const parameters = new URL(apiRequest(event).url).searchParams;
  const pagination = catalogPageRequest(parameters);
  const parentValue = parameters.get("parentId");

  if (parameters.getAll("parentId").length > 1)
    fail(400, "INVALID_DIRECTORY_PARENT", "目录父级无效");
  if (parentValue === "") fail(400, "INVALID_DIRECTORY_PARENT", "目录父级无效");

  return json(
    await directoryPage(
      workspaceId,
      user.id,
      parentValue,
      pagination?.limit ?? 30,
      pagination?.cursor,
    ),
  );
});
