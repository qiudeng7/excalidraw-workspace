import { defineApiHandler } from "#server/utils/api";
import { requireUser, rateLimit, currentSessionHash } from "#server/utils/auth";
import { apiRequest } from "#server/utils/request";
import { body, fail, json, assertOwner } from "#server/utils/http";
import { hashPassword, verifyPassword } from "#server/utils/passwords";
import { changeAccountPassword, userByEmail } from "#server/db/accounts";

export default defineApiHandler(async (event) => {
  const user = await requireUser(event);
  const req = apiRequest(event);

  assertOwner(req, user.id, "x-account-owner");
  await rateLimit(event, `password-change:${user.id}`, 10);
  const data = await body(req);

  if (
    typeof data.currentPassword !== "string" ||
    !data.currentPassword.length ||
    data.currentPassword.length > 256
  )
    return fail(400, "INVALID_CURRENT_PASSWORD", "请输入原密码");
  if (
    typeof data.newPassword !== "string" ||
    data.newPassword.length < 12 ||
    data.newPassword.length > 256
  )
    return fail(400, "INVALID_PASSWORD", "新密码需为 12–256 个字符");
  if (data.currentPassword === data.newPassword)
    return fail(400, "PASSWORD_UNCHANGED", "新密码不能与原密码相同");
  const account = await userByEmail(user.email);

  if (
    !account ||
    !(await verifyPassword(data.currentPassword, account.passwordHash))
  )
    return fail(403, "INVALID_CURRENT_PASSWORD", "原密码不正确");
  const updated = await changeAccountPassword(
    user.id,
    account.passwordHash,
    await hashPassword(data.newPassword),
    await currentSessionHash(event),
  );

  if (!updated)
    return fail(409, "PASSWORD_CHANGED", "密码已发生变化，请重新登录后再试");

  return json({ updated: true });
});
