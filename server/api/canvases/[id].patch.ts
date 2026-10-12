import { renameCanvas } from "#server/db/canvases";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { requireCanvas } from "#server/utils/access";
import { meta } from "#server/utils/snapshots";
import { json, body, name } from "#server/utils/http";

import { canvasCommand, projectMember } from "#server/collaboration/service";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  const req = apiRequest(event);
  const user = await requireUser(event);
  const row = await requireCanvas(id, user);

  const data = await body(req);

  if (row.syncMode !== "legacy") {
    await canvasCommand(event, id, { type: "rename", name: name(data.name) });
    await projectMember(event, id);
  } else
    await renameCanvas(id, user.id, name(data.name), new Date().toISOString());

  return json({ canvas: meta(await requireCanvas(id, user)) });
});
