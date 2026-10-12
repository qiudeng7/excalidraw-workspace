import { deleteWorkspace } from "../../db/workspaces";
import { runBackground } from "../../utils/request";
import { defineApiHandler, resourceId } from "../../utils/api";
import { requireUser } from "../../utils/auth";
import { requireWorkspace } from "../../utils/access";
import { deleteSnapshots } from "../../utils/snapshots";
import { json } from "../../utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  const user = await requireUser(event);

  await requireWorkspace(id, user);

  const keys = await deleteWorkspace(id, user.id);

  if (keys.length) runBackground(event, deleteSnapshots(keys));

  return json({});
});
