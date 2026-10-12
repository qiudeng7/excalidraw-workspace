import { defineApiHandler, resourceId } from "../../utils/api";
import { apiRequest } from "../../utils/request";
import { requireUser } from "../../utils/auth";
import { requireCanvas } from "../../utils/access";
import { meta } from "../../utils/snapshots";
import { json, body, name } from "../../utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);
  const repository = await event.context.repository();

  const req = apiRequest(event);
  const user = await requireUser(event);
  const row = await requireCanvas(repository, id, user);

  const data = await body(req);

  await repository.renameCanvas(
    id,
    user.id,
    name(data.name),
    new Date().toISOString(),
  );

  return json({ canvas: meta(await requireCanvas(repository, id, user)) });
});
