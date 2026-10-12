import { defineApiHandler, resourceId } from "../../../../utils/api";
import { body, json, fail } from "../../../../utils/http";
import { apiRequest } from "../../../../utils/request";
import { random, digest } from "../../../../utils/passwords";
import { canvasCommand } from "../../../../collaboration/service";
import { rateLimit } from "../../../../utils/auth";

export default defineApiHandler(
  async (event) => {
    await rateLimit(event, `share-exchange:${resourceId(event)}`, 200, 60);
    const data = await body(apiRequest(event));

    if (typeof data.secret !== "string" || data.secret.length !== 64)
      return fail(403, "INVALID_SHARE", "分享链接无效");
    const token = random();
    const result = await canvasCommand<{ expiresAt: number }>(
      event,
      resourceId(event),
      {
        type: "exchange",
        secretHash: await digest(data.secret),
        capabilityHash: await digest(token),
        guestId: crypto.randomUUID(),
      },
    );

    return json({ token, ...result });
  },
  { public: true },
);
