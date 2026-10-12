import { workspaces } from "#server/db/workspaces";
import { defineApiHandler } from "#server/utils/api";
import { requireUser } from "#server/utils/auth";
import { json } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const user = await requireUser(event);

  return json({ workspaces: await workspaces(user.id) });
});
