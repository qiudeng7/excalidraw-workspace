import { defineApiHandler } from "#server/utils/api";
import { authConfig } from "#server/utils/auth-methods";
import { oidcRedirectUri } from "#server/utils/auth-config";
import { requestOrigin } from "#server/utils/request";
import { random } from "#server/utils/passwords";
import { authorizationUrl, discover } from "#server/utils/oidc";
import {
  flowCookie,
  loginRedirect,
  failureRedirect,
  OIDC_FLOW_SECONDS,
} from "#server/utils/oidc-flow";

export default defineApiHandler(
  async (event) => {
    const { oidc } = authConfig(event);

    if (!oidc) return loginRedirect("oidc_disabled");
    try {
      const origin = requestOrigin(event);
      const flow = { state: random(), nonce: random(), verifier: random() };
      const { authorization_endpoint } = await discover(oidc);
      const redirectUri = oidcRedirectUri(oidc, origin);
      const location = await authorizationUrl(
        oidc,
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
            `${flow.state}.${flow.verifier}.${flow.nonce}`,
            OIDC_FLOW_SECONDS,
            redirectUri,
          ),
        },
      });
    } catch (error) {
      return failureRedirect(error, {}, oidc.postLoginPath);
    }
  },
  { public: true },
);
