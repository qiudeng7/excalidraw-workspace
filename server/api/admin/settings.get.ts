import { registration } from "#server/db/accounts";
import { defineApiHandler } from "#server/utils/api";
import { requireUser } from "#server/utils/auth";
import { fail, json } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const user = await requireUser(event);

  if (user.role !== "admin")
    return fail(403, "FORBIDDEN", "仅管理员可以修改注册设置");
  const settings = await registration();

  return json({ registrationEnabled: !!settings?.registrationEnabled });
});
