import { userSettings } from "../db/user-settings";
import { defineApiHandler } from "../utils/api";
import { apiRequest } from "../utils/request";
import { requireUser } from "../utils/auth";
import { json, assertOwner } from "../utils/http";
import { validateUserSettings } from "../utils/userSettings";
import { createDefaultUserSettings } from "../../shared/contracts";

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
  const settings: unknown = JSON.parse(row.settingsJson);

  if (!validateUserSettings(settings))
    throw new Error("Invalid stored user settings");

  return json({ settings, revision: row.revision, configured: true });
});
