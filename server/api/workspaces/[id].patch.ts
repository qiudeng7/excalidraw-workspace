import { renameWorkspace } from "#server/db/workspaces";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { requireWorkspace } from "#server/utils/access";
import { json, body, name } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  const req = apiRequest(event);
  const user = await requireUser(event);

  await requireWorkspace(id, user);

  const data = await body(req);

  await renameWorkspace(id, user.id, name(data.name), new Date().toISOString());

  return json({
    workspace: await requireWorkspace(id, user),
  });
});
