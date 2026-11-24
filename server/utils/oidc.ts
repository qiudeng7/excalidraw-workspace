import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OidcProviderType } from "#shared/oidc";
import type { OidcClaims } from "#server/utils/oidc-accounts";

/** 校验所需的最小身份源字段；与数据库行解耦，便于缓存和测试。 */
export interface OidcProvider {
  type: OidcProviderType;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

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

/** 微软多租户入口：discovery 返回 {tenantid} 模板，id_token 的 iss 带实际租户。 */
const MULTI_TENANT_ISSUER =
  /^https:\/\/login\.microsoftonline\.com\/(?:common|organizations|consumers|\{tenantid\})\/v2\.0$/i;
const TENANT_ISSUER_TEMPLATE =
  /^https:\/\/login\.microsoftonline\.com\/\{tenantid\}\/v2\.0$/i;

function normalize(issuer: string) {
  return issuer.replace(/\/+$/, "");
}

export function isMultiTenantProvider(provider: {
  type: OidcProviderType;
  issuer: string;
}) {
  return (
    provider.type === "microsoft" && MULTI_TENANT_ISSUER.test(provider.issuer)
  );
}

/** discovery 文档必须从具体端点获取；{tenantid} 模板用 common 取。 */
export function discoveryIssuer(provider: OidcProvider) {
  return isMultiTenantProvider(provider)
    ? provider.issuer.replace("{tenantid}", "common")
    : provider.issuer;
}

function discoveryIssuerMatches(provider: OidcProvider, issuer: string) {
  if (normalize(issuer) === normalize(discoveryIssuer(provider))) return true;

  // 多租户文档里的 issuer 是模板，真正的校验在 expectedIssuer() 里用 tid 展开。
  return isMultiTenantProvider(provider) && TENANT_ISSUER_TEMPLATE.test(issuer);
}

/**
 * id_token 的 iss 期望值。微软多租户用 id_token 的 tid 展开租户；
 * 配置了具体租户 issuer 或其它类型时严格使用配置值。
 */
export function expectedIssuer(
  provider: OidcProvider,
  claims: Record<string, unknown>,
) {
  if (!isMultiTenantProvider(provider)) return provider.issuer;
  const tid = typeof claims.tid === "string" ? claims.tid.trim() : "";

  if (!/^[0-9a-zA-Z.-]{1,100}$/.test(tid)) return null;

  return `https://login.microsoftonline.com/${tid}/v2.0`;
}

export async function discover(
  provider: OidcProvider,
  fetcher: typeof fetch = fetch,
): Promise<Discovery> {
  const issuer = discoveryIssuer(provider);
  const cached = discoveries.get(issuer);

  if (cached && cached.expires > Date.now()) return cached.value;
  let document: Record<string, unknown>;

  try {
    const response = await fetcher(
      `${issuer}/.well-known/openid-configuration`,
      { headers: { Accept: "application/json" } },
    );

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    document = await response.json();
  } catch (error) {
    throw new OidcError("oidc_unavailable", "OIDC discovery failed", {
      cause: error,
    });
  }

  const {
    issuer: documentIssuer,
    authorization_endpoint,
    token_endpoint,
    jwks_uri,
  } = document;

  if (
    typeof documentIssuer !== "string" ||
    !discoveryIssuerMatches(provider, documentIssuer) ||
    typeof authorization_endpoint !== "string" ||
    typeof token_endpoint !== "string" ||
    typeof jwks_uri !== "string"
  )
    throw new OidcError("oidc_unavailable", "OIDC discovery document invalid");
  const value = { authorization_endpoint, token_endpoint, jwks_uri };

  discoveries.set(issuer, { value, expires: Date.now() + DISCOVERY_TTL });

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
  provider: OidcProvider,
  endpoint: string,
  redirectUri: string,
  flow: { state: string; nonce: string; verifier: string },
) {
  const url = new URL(endpoint);

  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    scope: provider.scopes,
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
  provider: OidcProvider,
  idToken: string,
  nonce: string,
  keys: Parameters<typeof jwtVerify>[1],
): Promise<OidcClaims> {
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      audience: provider.clientId,
      algorithms: ["RS256", "ES256"],
    });
    const expected = expectedIssuer(provider, payload);

    if (
      !expected ||
      typeof payload.iss !== "string" ||
      payload.iss.toLowerCase() !== expected.toLowerCase()
    )
      throw new Error("issuer mismatch");
    if (
      payload.nonce !== nonce ||
      typeof payload.sub !== "string" ||
      !payload.sub
    )
      throw new Error("nonce or subject mismatch");

    return payload as unknown as OidcClaims;
  } catch (error) {
    throw new OidcError("oidc_invalid_token", "id_token rejected", {
      cause: error,
    });
  }
}

export async function exchangeCode(
  provider: OidcProvider,
  redirectUri: string,
  code: string,
  verifier: string,
  nonce: string,
  fetcher: typeof fetch = fetch,
): Promise<OidcClaims> {
  const endpoints = await discover(provider, fetcher);
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
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
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

  return verifyIdToken(provider, idToken, nonce, keys);
}
