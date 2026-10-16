import { defineApiHandler, resourceId } from "#server/utils/api";
import { body, json } from "#server/utils/http";
import { apiRequest } from "#server/utils/request";
import { principal } from "#server/collaboration/service";
import { roomCommand } from "#server/collaboration/transport";
import {
  canvasSessionKey,
  countCanvasSessions,
  leaveCanvasSession,
  touchCanvasSession,
} from "#server/collaboration/open-sessions";
import type { Access } from "#shared/collaboration/types";

export default defineApiHandler(
  async (event) => {
    const id = resourceId(event);
    // Presence must never create a room (including a delayed leave from an old tab).
    const status = await roomCommand<{
      access: Access;
      epoch: string;
      seq: number;
      name: string;
    }>(event, id, await principal(event), {
      type: "status",
    });
    const { access } = status;
    const data = await body(apiRequest(event));
    const key = await canvasSessionKey(access, data.clientId);
    let participants: number;
    let leaseExpiresAt: number | undefined;

    if (data.leave === true || access.viewMode !== "live") {
      // Missing tokens from older clients cannot remove a newer tab lease.
      if (
        typeof data.leaseExpiresAt === "number" &&
        Number.isSafeInteger(data.leaseExpiresAt) &&
        data.leaseExpiresAt > 0
      )
        await leaveCanvasSession(id, key, data.leaseExpiresAt);
      participants = await countCanvasSessions(id);
    } else
      ({ participants, leaseExpiresAt } = await touchCanvasSession(id, key));

    return json({
      ...status,
      participants,
      leaseExpiresAt,
      realtime: access.viewMode === "live" && participants > 1,
    });
  },
  { public: true },
);
