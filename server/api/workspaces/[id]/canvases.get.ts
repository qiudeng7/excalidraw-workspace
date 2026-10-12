import { canvasCatalog } from "../../../db/canvases";
import { defineApiHandler, resourceId } from "../../../utils/api";
import { requireUser } from "../../../utils/auth";
import { requireWorkspace } from "../../../utils/access";
import { json } from "../../../utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  const user = await requireUser(event);

  await requireWorkspace(id, user);

  return json(await canvasCatalog(id, user.id));
});
