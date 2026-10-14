import { defineApiHandler, resourceId } from "#server/utils/api";
import { requireUser } from "#server/utils/auth";
import { requireCanvas } from "#server/utils/access";
import { apiRequest } from "#server/utils/request";
import { assertOwner, body, json } from "#server/utils/http";
import { ensureRoom, principal } from "#server/collaboration/service";
import {
  canvasSessionKey,
  countCanvasSessions,
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

  const key = await canvasSessionKey(
    { principalId: `user:${user.id}` },
    data.clientId,
  );
  let participants: number;
  let leaseExpiresAt: number | undefined;

  if (data.leave === true) {
    // Missing tokens from older clients cannot remove a newer tab lease.
    if (
      typeof data.leaseExpiresAt === "number" &&
      Number.isSafeInteger(data.leaseExpiresAt) &&
      data.leaseExpiresAt > 0
    )
      await leaveCanvasSession(id, key, data.leaseExpiresAt);
    participants = await countCanvasSessions(id);
  } else {
    ({ participants, leaseExpiresAt } = await touchCanvasSession(id, key));

    if (
      row.syncMode === "preparing" ||
      (row.syncMode === "legacy" && participants > 1)
    ) {
      await ensureRoom(event, id, await principal(event));
      row = await requireCanvas(id, user);
    }
  }

  return json({
    syncMode: row.syncMode,
    participants,
    leaseExpiresAt,
    realtime: participants > 1,
  });
});
