import { defineApiHandler } from "../../utils/api";
import { apiRequest } from "../../utils/request";
import { requireUser } from "../../utils/auth";
import { fail, json, body } from "../../utils/http";

export default defineApiHandler(async (event) => {
  const repository = await event.context.repository();

  const req = apiRequest(event);
  const user = await requireUser(event);

  if (user.role !== "admin")
    return fail(403, "FORBIDDEN", "仅管理员可以修改注册设置");

  const data = await body(req);

  if (typeof data.registrationEnabled !== "boolean")
    return fail(400, "INVALID_SETTINGS", "注册设置必须是布尔值");
  await repository.setRegistration(data.registrationEnabled);
  const settings = await repository.registration();

  return json({ registrationEnabled: !!settings?.registration_enabled });
});
