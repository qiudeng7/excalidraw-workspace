import { enabledOidcProviders } from "#server/db/oidc-providers";
import { developmentAccounts } from "#server/utils/development";
import { administrator, registration } from "#server/db/accounts";
import { defineApiHandler } from "#server/utils/api";
import { json } from "#server/utils/http";
import { authConfig } from "#server/utils/auth-methods";
import { providerSummary } from "#server/utils/oidc-providers";

export default defineApiHandler(
  async (event) => {
    const auth = authConfig(event);
    const presets = developmentAccounts(event);
    const admin = await administrator();
    const settings = await registration();
    const providers = await enabledOidcProviders();

    return json({
      ...(presets ? { developmentAccounts: presets } : {}),
      needsSetup: !admin,
      registrationEnabled: !!settings?.registrationEnabled,
      emailVerification: false,
      authMethods: {
        local: auth.local,
        oidc: providers.map(providerSummary),
      },
    });
  },
  { public: true },
);
