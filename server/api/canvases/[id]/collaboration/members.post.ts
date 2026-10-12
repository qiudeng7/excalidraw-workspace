import { defineApiHandler, resourceId } from "#server/utils/api";
import { body, json, fail } from "#server/utils/http";
import { apiRequest } from "#server/utils/request";
import { canvasCommand, projectMember } from "#server/collaboration/service";
import { userByEmail } from "#server/db/accounts";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  await canvasCommand(event, id, { type: "manage" });
  const data = await body(apiRequest(event));

  if (typeof data.email !== "string")
    return fail(400, "INVALID_EMAIL", "请输入已有账号的邮箱");
  const user = await userByEmail(data.email.trim().toLowerCase());

  if (!user) return fail(404, "ACCOUNT_NOT_FOUND", "没有找到这个账号");
  await canvasCommand(event, id, {
    type: "member",
    member: {
      ...data,
      id: crypto.randomUUID(),
      userId: user.id,
      name: user.name,
    },
  });
  await projectMember(event, id);

  return json({ ok: true });
});
