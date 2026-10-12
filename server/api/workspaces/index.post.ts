import { createWorkspace } from "#server/db/workspaces";
import { defineApiHandler } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { requireWorkspace } from "#server/utils/access";
import { json, body, name } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const req = apiRequest(event);
  const user = await requireUser(event);

  const data = await body(req);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await createWorkspace(id, user.id, name(data.name), now);

  return json({ workspace: await requireWorkspace(id, user) });
});
