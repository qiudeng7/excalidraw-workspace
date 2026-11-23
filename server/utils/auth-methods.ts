import type { H3Event } from "h3";
import { fail } from "#server/utils/http";
import { parseAuthConfig, AuthConfigError } from "#server/utils/auth-config";

/** Resolve configuration from Worker bindings first, then the Node environment. */
export function authConfig(event: H3Event) {
  try {
    return parseAuthConfig({
      ...process.env,
      ...(event.context.cloudflare?.env ?? {}),
    });
  } catch (error) {
    if (error instanceof AuthConfigError)
      return fail(500, "CONFIGURATION_INVALID", error.message);
    throw error;
  }
}

/** Local-account endpoints disappear when only OIDC is enabled. */
export function requireLocalAuth(event: H3Event) {
  if (!authConfig(event).local)
    fail(403, "AUTH_METHOD_DISABLED", "本地账号登录已停用");
}
