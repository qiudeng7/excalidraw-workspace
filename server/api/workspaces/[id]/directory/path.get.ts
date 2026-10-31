import { directoryPath } from "#server/db/directory-path";
import type { NodeRef } from "#shared/directory-contracts";
import { requireUser } from "#server/utils/auth";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { fail, json } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const workspaceId = resourceId(event);
  const user = await requireUser(event);
  const parameters = new URL(apiRequest(event).url).searchParams;
  const kind = parameters.get("kind");
  const id = parameters.get("id");

  if (
    parameters.getAll("kind").length !== 1 ||
    parameters.getAll("id").length !== 1 ||
    (kind !== "folder" && kind !== "canvas") ||
    !id
  )
    return fail(400, "INVALID_DIRECTORY_ITEM", "目录项目无效");

  return json(
    await directoryPath(workspaceId, user.id, { kind, id } satisfies NodeRef),
  );
});
