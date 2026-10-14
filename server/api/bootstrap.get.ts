import { developmentAccounts } from "#server/utils/development";
import { administrator, registration } from "#server/db/accounts";
import { defineApiHandler } from "#server/utils/api";
import { json } from "#server/utils/http";

export default defineApiHandler(
  async (event) => {
    const presets = developmentAccounts(event);
    const admin = await administrator();
    const settings = await registration();

    return json({
      ...(presets ? { developmentAccounts: presets } : {}),
      needsSetup: !admin,
      registrationEnabled: !!settings?.registrationEnabled,
      emailVerification: false,
    });
  },
  { public: true },
);
