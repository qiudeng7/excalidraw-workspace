import { defineApiHandler, resourceId } from "../../../utils/api";
import { requireUser } from "../../../utils/auth";
import { requireWorkspace } from "../../../utils/access";
import { json } from "../../../utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);
  const repository = await event.context.repository();

  const user = await requireUser(event);

  await requireWorkspace(repository, id, user);

  return json(await repository.canvasCatalog(id, user.id));
});
