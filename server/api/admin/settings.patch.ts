import { registration, setRegistration } from "#server/db/accounts";
import { defineApiHandler } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { fail, json, body } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const req = apiRequest(event);
  const user = await requireUser(event);

  if (user.role !== "admin")
    return fail(403, "FORBIDDEN", "仅管理员可以修改注册设置");

  const data = await body(req);

  if (typeof data.registrationEnabled !== "boolean")
    return fail(400, "INVALID_SETTINGS", "注册设置必须是布尔值");
  await setRegistration(data.registrationEnabled);
  const settings = await registration();

  return json({ registrationEnabled: !!settings?.registrationEnabled });
});
