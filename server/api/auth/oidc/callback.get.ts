import { getCookie, getQuery } from "h3";
import { defineApiHandler } from "#server/utils/api";
import { authConfig } from "#server/utils/auth-methods";
import { oidcRedirectUri } from "#server/utils/auth-config";
import { rateLimit, startSession } from "#server/utils/auth";
import { requestClientIp, requestOrigin } from "#server/utils/request";
import { digest } from "#server/utils/passwords";
import { NO_PASSWORD } from "#server/db/accounts";
import { exchangeCode, OidcError } from "#server/utils/oidc";
import { findOrCreateOidcUser } from "#server/utils/oidc-accounts";
import {
  OIDC_FLOW_COOKIE,
  failureRedirect,
  flowCookie,
  loginRedirect,
} from "#server/utils/oidc-flow";

export default defineApiHandler(
  async (event) => {
    const { oidc } = authConfig(event);

    if (!oidc) return loginRedirect("oidc_disabled");
    const origin = requestOrigin(event);
    // One-shot: whatever happens next, the flow cookie is spent.
    const clear = flowCookie(origin, "", 0, oidcRedirectUri(oidc, origin));

    try {
      await rateLimit(
        event,
        `oidc-ip:${await digest(requestClientIp(event))}`,
        40,
      );
      const query = getQuery(event);
      const [state, verifier, nonce] = (
        getCookie(event, OIDC_FLOW_COOKIE) ?? ""
      ).split(".");

      if (typeof query.error === "string")
        throw new OidcError("oidc_denied", "IdP returned an error");
      if (
        !state ||
        !verifier ||
        !nonce ||
        query.state !== state ||
        typeof query.code !== "string"
      )
        throw new OidcError("oidc_state", "state mismatch");
      const claims = await exchangeCode(
        oidc,
        oidcRedirectUri(oidc, origin),
        query.code,
        verifier,
        nonce,
      );
      const user = await findOrCreateOidcUser(oidc.issuer, claims);
      const session = await startSession(event, user, NO_PASSWORD);

      if (!session) throw new OidcError("oidc_failed", "session rejected");
      const headers = new Headers({
        Location: oidc.postLoginPath,
        "Cache-Control": "no-store",
      });

      headers.append("Set-Cookie", session);
      headers.append("Set-Cookie", clear);

      return new Response(null, { status: 302, headers });
    } catch (error) {
      return failureRedirect(
        error,
        { "Set-Cookie": clear },
        oidc.postLoginPath,
      );
    }
  },
  { public: true },
);
