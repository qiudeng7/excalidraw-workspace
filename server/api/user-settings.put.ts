import { saveUserSettings, userSettings } from "#server/db/user-settings";
import { defineApiHandler } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import {
  fail,
  json,
  body,
  validRevision,
  assertOwner,
} from "#server/utils/http";
import {
  completeUserSettingsWrite,
  readStoredUserSettings,
  validateUserSettings,
  validateUserSettingsWrite,
} from "#server/utils/userSettings";

export default defineApiHandler(async (event) => {
  const req = apiRequest(event);
  const user = await requireUser(event);

  assertOwner(req, user.id, "x-settings-owner");

  const data = await body(req);
  const revision = validRevision(data.revision);

  if (!validateUserSettingsWrite(data.settings))
    return fail(
      400,
      "INVALID_USER_SETTINGS",
      "设置格式无效，请使用完整的受支持配置",
    );
  let previous;

  if (!validateUserSettings(data.settings)) {
    const row = await userSettings(user.id);

    if (row) {
      previous = readStoredUserSettings(JSON.parse(row.settingsJson));
      if (!previous) throw new Error("Invalid stored user settings");
    }
  }

  const settings = completeUserSettingsWrite(data.settings, previous);
  // CAS also protects the read/merge gap: a competing write makes this save conflict.
  const updatedRevision = await saveUserSettings(
    user.id,
    JSON.stringify(settings),
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
    settings,
    revision: updatedRevision,
    configured: true,
  });
});
