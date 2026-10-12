import { defineApiHandler, resourceId } from "#server/utils/api";
import { body, json, fail } from "#server/utils/http";
import { apiRequest } from "#server/utils/request";
import { canvasCommand, projectMember } from "#server/collaboration/service";

export default defineApiHandler(async (event) => {
  const data = await body(apiRequest(event));

  if (typeof data.userId !== "string")
    return fail(400, "INVALID_MEMBER", "成员无效");
  await canvasCommand(event, resourceId(event), {
    type: "removeMember",
    userId: data.userId,
  });
  await projectMember(event, resourceId(event));

  return json({ ok: true });
});
