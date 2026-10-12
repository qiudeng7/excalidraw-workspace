import { canvasCatalog } from "#server/db/canvases";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { requireUser } from "#server/utils/auth";
import { requireWorkspace } from "#server/utils/access";
import { json } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  const user = await requireUser(event);

  await requireWorkspace(id, user);

  return json(await canvasCatalog(id, user.id));
});
