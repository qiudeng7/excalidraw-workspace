import { defineApiHandler, resourceId } from "#server/utils/api";
import { body, json, fail } from "#server/utils/http";
import { apiRequest } from "#server/utils/request";
import { random, digest } from "#server/utils/passwords";
import { canvasCommand } from "#server/collaboration/service";

export default defineApiHandler(async (event) => {
  const data = await body(apiRequest(event));
  const secret = random(),
    id = crypto.randomUUID();
  const expiresAt =
    data.expiresAt === null
      ? null
      : data.expiresAt === undefined
        ? Date.now() + 7 * 86400000
        : Number(data.expiresAt);

  if (
    expiresAt !== null &&
    (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
  )
    return fail(400, "INVALID_EXPIRY", "过期时间无效");
  await canvasCommand(event, resourceId(event), {
    type: "link",
    link: {
      ...data,
      role: data.role ?? "viewer",
      viewMode: data.viewMode ?? "latest",
      id,
      secretHash: await digest(secret),
      requireLogin: data.requireLogin !== false,
      expiresAt,
    },
  });

  return json({
    id,
    path: `/share/${encodeURIComponent(resourceId(event))}#${secret}`,
  });
});
