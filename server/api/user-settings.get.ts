import { userSettings } from "#server/db/user-settings";
import { defineApiHandler } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { json, assertOwner } from "#server/utils/http";
import { readStoredUserSettings } from "#server/utils/userSettings";
import { createDefaultUserSettings } from "#shared/contracts";

export default defineApiHandler(async (event) => {
  const req = apiRequest(event);
  const user = await requireUser(event);

  assertOwner(req, user.id, "x-settings-owner");

  const row = await userSettings(user.id);

  if (!row)
    return json({
      settings: createDefaultUserSettings(),
      revision: 0,
      configured: false,
    });
  const settings = readStoredUserSettings(JSON.parse(row.settingsJson));

  if (!settings) throw new Error("Invalid stored user settings");

  return json({ settings, revision: row.revision, configured: true });
});
