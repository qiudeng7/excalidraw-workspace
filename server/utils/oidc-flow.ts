import { OidcError } from "#server/utils/oidc";

export const OIDC_FLOW_SECONDS = 600;

export const OIDC_FLOW_COOKIE = "excalidraw_oidc";

/** 一次登录流程的 Cookie 内容；providerId 用于回调时核对发起的身份源。 */
export interface OidcFlow {
  providerId: string;
  state: string;
  verifier: string;
  nonce: string;
}

export function flowValue(flow: OidcFlow) {
  return [flow.providerId, flow.state, flow.verifier, flow.nonce].join(".");
}

export function parseFlow(value: string): OidcFlow | null {
  const [providerId, state, verifier, nonce] = value.split(".");

  return providerId && state && verifier && nonce
    ? { providerId, state, verifier, nonce }
    : null;
}

/**
 * Short-lived, HttpOnly. SameSite=Lax because the IdP returns via a cross-site navigation.
 * Scoped to the public callback's directory, which is also the provider's own segment.
 */
export function flowCookie(
  origin: string,
  value: string,
  age: number,
  redirectUri: string,
) {
  const path = new URL(redirectUri).pathname.replace(/\/[^/]*$/, "") || "/";

  return `${OIDC_FLOW_COOKIE}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${age}${new URL(origin).protocol === "https:" ? "; Secure" : ""}`;
}

/** 成功与失败都回到站点根路径；失败只带一个 authError 代码。 */
export function loginRedirect(code?: string, headers: HeadersInit = {}) {
  const location = new URL("/", "http://placeholder");

  if (code) location.searchParams.set("authError", code);

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${location.pathname}${location.search}${location.hash}`,
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

/** Never reveal internals to the browser; log the cause server-side. */
export function failureRedirect(error: unknown, headers: HeadersInit = {}) {
  const code = error instanceof OidcError ? error.code : "oidc_failed";

  console.error(
    "OIDC login failed",
    code,
    error instanceof Error ? error.message : "unknown",
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : "",
  );

  return loginRedirect(code, headers);
}
