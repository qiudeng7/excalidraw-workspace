import { renameCanvas } from "../../db/canvases";
import { defineApiHandler, resourceId } from "../../utils/api";
import { apiRequest } from "../../utils/request";
import { requireUser } from "../../utils/auth";
import { requireCanvas } from "../../utils/access";
import { meta } from "../../utils/snapshots";
import { json, body, name } from "../../utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  const req = apiRequest(event);
  const user = await requireUser(event);
  const row = await requireCanvas(id, user);

  const data = await body(req);

  await renameCanvas(id, user.id, name(data.name), new Date().toISOString());

  return json({ canvas: meta(await requireCanvas(id, user)) });
});
