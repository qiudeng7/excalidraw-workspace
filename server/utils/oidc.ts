import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OidcConfig } from "#server/utils/auth-config";
import type { OidcClaims } from "#server/utils/oidc-accounts";

export class OidcError extends Error {
  constructor(
    public code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const DISCOVERY_TTL = 60 * 60 * 1000;
const discoveries = new Map<string, { value: Discovery; expires: number }>();
// createRemoteJWKSet caches keys and refetches on unknown kid; keep one per endpoint.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function discover(
  config: OidcConfig,
  fetcher: typeof fetch = fetch,
): Promise<Discovery> {
  const cached = discoveries.get(config.issuer);

  if (cached && cached.expires > Date.now()) return cached.value;
  let document: Record<string, unknown>;

  try {
    const response = await fetcher(
      `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
      { headers: { Accept: "application/json" } },
    );

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    document = await response.json();
  } catch (error) {
    throw new OidcError("oidc_unavailable", "OIDC discovery failed", {
      cause: error,
    });
  }

  const { issuer, authorization_endpoint, token_endpoint, jwks_uri } = document;

  if (
    issuer !== config.issuer ||
    typeof authorization_endpoint !== "string" ||
    typeof token_endpoint !== "string" ||
    typeof jwks_uri !== "string"
  )
    throw new OidcError("oidc_unavailable", "OIDC discovery document invalid");
  const value = { authorization_endpoint, token_endpoint, jwks_uri };

  discoveries.set(config.issuer, {
    value,
    expires: Date.now() + DISCOVERY_TTL,
  });

  return value;
}

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function pkceChallenge(verifier: string) {
  return base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
}

export async function authorizationUrl(
  config: OidcConfig,
  endpoint: string,
  redirectUri: string,
  flow: { state: string; nonce: string; verifier: string },
) {
  const url = new URL(endpoint);

  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes,
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: await pkceChallenge(flow.verifier),
    code_challenge_method: "S256",
  }))
    url.searchParams.set(key, value);

  return url.href;
}

/** Verify signature (RS256/ES256), issuer, audience, expiry and nonce. */
export async function verifyIdToken(
  config: OidcConfig,
  idToken: string,
  nonce: string,
  keys: Parameters<typeof jwtVerify>[1],
): Promise<OidcClaims> {
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: ["RS256", "ES256"],
    });

    if (
      payload.nonce !== nonce ||
      typeof payload.sub !== "string" ||
      !payload.sub
    )
      throw new Error("nonce or subject mismatch");

    return payload as OidcClaims;
  } catch (error) {
    throw new OidcError("oidc_invalid_token", "id_token rejected", {
      cause: error,
    });
  }
}

export async function exchangeCode(
  config: OidcConfig,
  redirectUri: string,
  code: string,
  verifier: string,
  nonce: string,
  fetcher: typeof fetch = fetch,
): Promise<OidcClaims> {
  const endpoints = await discover(config, fetcher);
  let idToken: unknown;

  try {
    const response = await fetcher(endpoints.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: verifier,
      }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    idToken = ((await response.json()) as { id_token?: unknown }).id_token;
  } catch (error) {
    throw new OidcError("oidc_token_failed", "OIDC token exchange failed", {
      cause: error,
    });
  }

  if (typeof idToken !== "string")
    throw new OidcError("oidc_token_failed", "OIDC response has no id_token");
  let keys = keySets.get(endpoints.jwks_uri);

  if (!keys) {
    keys = createRemoteJWKSet(new URL(endpoints.jwks_uri));
    keySets.set(endpoints.jwks_uri, keys);
  }

  return verifyIdToken(config, idToken, nonce, keys);
}
