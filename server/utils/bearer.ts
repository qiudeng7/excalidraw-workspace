import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { oidcProviderByIssuer } from "#server/db/oidc-providers";
import { userByIdentity } from "#server/db/accounts";
import { createOidcUser, type OidcClaims } from "#server/utils/oidc-accounts";
import { discover } from "#server/utils/oidc";
import { requestOrigin } from "#server/utils/request";
import type { OidcProvider } from "#server/utils/oidc";
import type { User } from "#shared/contracts";
import type { H3Event } from "h3";

export const EXCALIDRAW_READ_SCOPE = "excalidraw:canvas.read";

export const EXCALIDRAW_WRITE_SCOPE = "excalidraw:canvas.write";
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function tokenFrom(event: H3Event) {
  const value = event.headers.get("authorization") ?? "";

  return /^Bearer\s+([^\s]+)$/i.exec(value)?.[1];
}

function claimsForUser(payload: Record<string, unknown>): OidcClaims | null {
  if (typeof payload.sub !== "string" || !payload.sub) return null;

  return {
    iss: payload.iss,
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    preferred_username: payload.preferred_username,
    picture: payload.picture,
    tid: payload.tid,
  };
}

/** Audience must name this deployment; a token minted for another app is unusable here. */
function hasAudience(payload: Record<string, unknown>, resource: string) {
  const audience = Array.isArray(payload.aud)
    ? payload.aud.filter((value): value is string => typeof value === "string")
    : typeof payload.aud === "string"
      ? [payload.aud]
      : [];

  return audience.includes(resource);
}

function hasScope(payload: Record<string, unknown>, scope: string) {
  return (
    typeof payload.scope === "string" &&
    payload.scope.split(/\s+/).includes(scope)
  );
}

async function providerForIssuer(issuer: string) {
  const row = await oidcProviderByIssuer(issuer);

  if (!row) return null;

  return {
    type: row.type,
    issuer: row.issuer,
    clientId: row.clientId,
    clientSecret: row.clientSecret,
    scopes: row.scopes,
  } satisfies OidcProvider;
}

/** Verify Identity access tokens and map their (iss, sub) to an Excalidraw account. */
export async function bearerUser(
  event: H3Event,
  requiredScope = EXCALIDRAW_READ_SCOPE,
): Promise<User | null> {
  const token = tokenFrom(event);

  if (!token) return null;
  try {
    const resource = requestOrigin(event);
    const unverified = decodeJwt(token);
    const issuer =
      typeof unverified.iss === "string"
        ? unverified.iss.replace(/\/+$/, "")
        : "";

    if (
      !issuer ||
      !hasAudience(unverified, resource) ||
      !hasScope(unverified, requiredScope)
    )
      return null;
    const provider = await providerForIssuer(issuer);

    if (!provider) return null;
    const endpoints = await discover(provider);
    let keys = keySets.get(endpoints.jwks_uri);

    if (!keys) {
      keys = createRemoteJWKSet(new URL(endpoints.jwks_uri));
      keySets.set(endpoints.jwks_uri, keys);
    }

    const { payload } = await jwtVerify(token, keys, {
      issuer,
      algorithms: ["RS256"],
    });

    if (!hasAudience(payload, resource) || !hasScope(payload, requiredScope))
      return null;
    const claims = claimsForUser(payload);

    if (!claims) return null;

    return (
      (await userByIdentity(issuer, claims.sub)) ??
      createOidcUser(issuer, claims)
    );
  } catch (error) {
    console.warn(
      "Bearer token rejected",
      error instanceof Error ? error.message : "unknown",
    );

    return null;
  }
}
