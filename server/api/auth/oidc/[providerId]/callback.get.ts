import { getCookie, getQuery } from "h3";
import { defineApiHandler } from "#server/utils/api";
import { oidcProvider } from "#server/db/oidc-providers";
import { rateLimit, startSession } from "#server/utils/auth";
import { requestClientIp, requestOrigin } from "#server/utils/request";
import { digest } from "#server/utils/passwords";
import { NO_PASSWORD, userByIdentity } from "#server/db/accounts";
import { exchangeCode, OidcError } from "#server/utils/oidc";
import { createOidcUser } from "#server/utils/oidc-accounts";
import {
  OIDC_FLOW_COOKIE,
  failureRedirect,
  flowCookie,
  loginRedirect,
  parseFlow,
} from "#server/utils/oidc-flow";
import { oidcCallbackUrl, oidcProviderId } from "#server/utils/oidc-providers";

export default defineApiHandler(
  async (event) => {
    const provider = await oidcProvider(oidcProviderId(event));

    if (!provider?.enabled) return loginRedirect("oidc_disabled");
    const origin = requestOrigin(event);
    // One-shot: whatever happens next, the flow cookie is spent.
    const clear = flowCookie(
      origin,
      "",
      0,
      oidcCallbackUrl(origin, provider.id),
    );

    try {
      await rateLimit(
        event,
        `oidc-ip:${await digest(requestClientIp(event))}`,
        40,
      );
      const query = getQuery(event);
      const flow = parseFlow(getCookie(event, OIDC_FLOW_COOKIE) ?? "");

      if (typeof query.error === "string")
        throw new OidcError("oidc_denied", "IdP returned an error");
      // 流程 Cookie 必须属于发起登录的同一个身份源。
      if (
        !flow ||
        flow.providerId !== provider.id ||
        query.state !== flow.state ||
        typeof query.code !== "string"
      )
        throw new OidcError("oidc_state", "state mismatch");
      const claims = await exchangeCode(
        provider,
        oidcCallbackUrl(origin, provider.id),
        query.code,
        flow.verifier,
        flow.nonce,
      );
      const issuer = typeof claims.iss === "string" ? claims.iss : "";

      if (!issuer)
        throw new OidcError("oidc_invalid_token", "Missing issuer claim");
      const mapped = await userByIdentity(issuer, claims.sub);

      if (!mapped && !provider.autoRegister)
        throw new OidcError(
          "oidc_not_registered",
          "No mapped account and auto registration is off",
        );
      const user = mapped ?? (await createOidcUser(issuer, claims));
      const session = await startSession(event, user, NO_PASSWORD);

      if (!session) throw new OidcError("oidc_failed", "session rejected");
      const headers = new Headers({
        Location: "/",
        "Cache-Control": "no-store",
      });

      headers.append("Set-Cookie", session);
      headers.append("Set-Cookie", clear);

      return new Response(null, { status: 302, headers });
    } catch (error) {
      return failureRedirect(error, { "Set-Cookie": clear });
    }
  },
  { public: true },
);
