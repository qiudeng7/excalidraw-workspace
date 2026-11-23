import { developmentAccounts } from "#server/utils/development";
import { administrator, registration } from "#server/db/accounts";
import { defineApiHandler } from "#server/utils/api";
import { json } from "#server/utils/http";
import { authConfig } from "#server/utils/auth-methods";

export default defineApiHandler(
  async (event) => {
    const auth = authConfig(event);
    const presets = developmentAccounts(event);
    const admin = await administrator();
    const settings = await registration();

    return json({
      ...(presets ? { developmentAccounts: presets } : {}),
      needsSetup: !admin,
      registrationEnabled: !!settings?.registrationEnabled,
      emailVerification: false,
      authMethods: { local: auth.local, oidc: !!auth.oidc },
    });
  },
  { public: true },
);
