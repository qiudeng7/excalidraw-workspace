import { saveUserSettings } from "../db/user-settings";
import { defineApiHandler } from "../utils/api";
import { apiRequest } from "../utils/request";
import { requireUser } from "../utils/auth";
import { fail, json, body, validRevision, assertOwner } from "../utils/http";
import { validateUserSettings } from "../utils/userSettings";

export default defineApiHandler(async (event) => {
  const req = apiRequest(event);
  const user = await requireUser(event);

  assertOwner(req, user.id, "x-settings-owner");

  const data = await body(req);
  const revision = validRevision(data.revision);

  if (!validateUserSettings(data.settings))
    return fail(
      400,
      "INVALID_USER_SETTINGS",
      "设置格式无效，请使用完整的受支持配置",
    );
  const updatedRevision = await saveUserSettings(
    user.id,
    JSON.stringify(data.settings),
    revision,
    new Date().toISOString(),
  );

  if (updatedRevision === undefined)
    return fail(
      409,
      "USER_SETTINGS_CONFLICT",
      "设置已在其他页面更新，请选择使用云端设置或重新提交当前设置",
    );

  return json({
    settings: data.settings,
    revision: updatedRevision,
    configured: true,
  });
});
