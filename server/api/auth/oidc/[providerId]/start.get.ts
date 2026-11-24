import { defineApiHandler } from "#server/utils/api";
import { requestOrigin } from "#server/utils/request";
import { random } from "#server/utils/passwords";
import { oidcProvider } from "#server/db/oidc-providers";
import { authorizationUrl, discover } from "#server/utils/oidc";
import {
  flowCookie,
  flowValue,
  failureRedirect,
  loginRedirect,
  OIDC_FLOW_SECONDS,
} from "#server/utils/oidc-flow";
import { oidcCallbackUrl, oidcProviderId } from "#server/utils/oidc-providers";

export default defineApiHandler(
  async (event) => {
    const provider = await oidcProvider(oidcProviderId(event));

    // 未启用或不存在都按同一错误返回，避免泄露身份源配置。
    if (!provider?.enabled) return loginRedirect("oidc_disabled");

    try {
      const origin = requestOrigin(event);
      const flow = {
        providerId: provider.id,
        state: random(),
        nonce: random(),
        verifier: random(),
      };
      const { authorization_endpoint } = await discover(provider);
      const redirectUri = oidcCallbackUrl(origin, provider.id);
      const location = await authorizationUrl(
        provider,
        authorization_endpoint,
        redirectUri,
        flow,
      );

      return new Response(null, {
        status: 302,
        headers: {
          Location: location,
          "Cache-Control": "no-store",
          "Set-Cookie": flowCookie(
            origin,
            flowValue(flow),
            OIDC_FLOW_SECONDS,
            redirectUri,
          ),
        },
      });
    } catch (error) {
      return failureRedirect(error);
    }
  },
  { public: true },
);
