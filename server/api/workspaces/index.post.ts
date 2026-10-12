import { createWorkspace } from "../../db/workspaces";
import { defineApiHandler } from "../../utils/api";
import { apiRequest } from "../../utils/request";
import { requireUser } from "../../utils/auth";
import { requireWorkspace } from "../../utils/access";
import { json, body, name } from "../../utils/http";

export default defineApiHandler(async (event) => {
  const req = apiRequest(event);
  const user = await requireUser(event);

  const data = await body(req);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await createWorkspace(id, user.id, name(data.name), now);

  return json({ workspace: await requireWorkspace(id, user) });
});
