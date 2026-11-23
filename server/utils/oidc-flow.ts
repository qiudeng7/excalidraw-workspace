import { OidcError } from "#server/utils/oidc";

export const OIDC_FLOW_SECONDS = 600;

export const OIDC_FLOW_COOKIE = "excalidraw_oidc";

/**
 * Short-lived, HttpOnly. SameSite=Lax because the IdP returns via a cross-site navigation.
 * Scoped to the public callback's directory so a proxy prefix (e.g. /apps/x) still matches.
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

export function loginRedirect(
  code: string,
  headers: HeadersInit = {},
  path = "/",
) {
  const location = new URL(path, "http://placeholder");

  location.searchParams.set("authError", code);

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
export function failureRedirect(
  error: unknown,
  headers: HeadersInit = {},
  path = "/",
) {
  const code = error instanceof OidcError ? error.code : "oidc_failed";

  console.error(
    "OIDC login failed",
    code,
    error instanceof Error ? error.message : "unknown",
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : "",
  );

  return loginRedirect(code, headers, path);
}
