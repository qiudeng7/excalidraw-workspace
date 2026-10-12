import { workspaces } from "../../db/workspaces";
import { defineApiHandler } from "../../utils/api";
import { requireUser } from "../../utils/auth";
import { json } from "../../utils/http";

export default defineApiHandler(async (event) => {
  const user = await requireUser(event);

  return json({ workspaces: await workspaces(user.id) });
});
