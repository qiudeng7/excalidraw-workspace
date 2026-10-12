import { defineApiHandler, resourceId } from "../../utils/api";
import { apiRequest } from "../../utils/request";
import { requireUser } from "../../utils/auth";
import { requireWorkspace } from "../../utils/access";
import { json, body, name } from "../../utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);
  const repository = await event.context.repository();

  const req = apiRequest(event);
  const user = await requireUser(event);

  await requireWorkspace(repository, id, user);

  const data = await body(req);

  await repository.renameWorkspace(
    id,
    user.id,
    name(data.name),
    new Date().toISOString(),
  );

  return json({
    workspace: await requireWorkspace(repository, id, user),
  });
});
