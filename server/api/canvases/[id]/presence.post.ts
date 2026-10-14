import { defineApiHandler, resourceId } from "#server/utils/api";
import { requireUser } from "#server/utils/auth";
import { requireCanvas } from "#server/utils/access";
import { apiRequest } from "#server/utils/request";
import { assertOwner, body, fail, json } from "#server/utils/http";
import { ensureRoom, principal } from "#server/collaboration/service";
import {
  leaveCanvasSession,
  touchCanvasSession,
} from "#server/collaboration/open-sessions";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);
  const user = await requireUser(event);
  const request = apiRequest(event);

  assertOwner(request, user.id, "x-resource-owner");
  let row = await requireCanvas(id, user);
  const data = await body(request);

  if (
    typeof data.clientId !== "string" ||
    !/^[a-zA-Z0-9_-]{16,100}$/.test(data.clientId)
  )
    return fail(400, "INVALID_CLIENT", "画布会话标识无效");
  if (data.leave === true || row.syncMode === "collaborative")
    await leaveCanvasSession(id, data.clientId);
  else {
    const concurrent = await touchCanvasSession(id, data.clientId);

    if (concurrent || row.syncMode === "preparing") {
      await ensureRoom(event, id, await principal(event));
      row = await requireCanvas(id, user);
      await leaveCanvasSession(id, data.clientId);
    }
  }

  return json({ syncMode: row.syncMode });
});
