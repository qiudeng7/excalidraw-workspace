/** Account-method configuration. Pure so the same rules serve Node startup, Workers requests and tests. */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** Explicit override; the default is derived from PUBLIC_ORIGIN by oidcRedirectUri(). */
  redirectUri?: string;
  /** Same-origin path the browser returns to after login or failure; "/" by default. */
  postLoginPath: string;
}

export interface AuthConfig {
  local: boolean;
  oidc: OidcConfig | null;
}

export class AuthConfigError extends Error {}

type Environment = Record<string, unknown>;

function flag(env: Environment, key: string, fallback: boolean) {
  const raw = env[key];

  if (raw === undefined || raw === null || String(raw).trim() === "")
    return fallback;
  const value = String(raw).trim().toLowerCase();

  if (["true", "1"].includes(value)) return true;
  if (["false", "0"].includes(value)) return false;
  throw new AuthConfigError(`${key} must be true or false`);
}

function text(env: Environment, key: string) {
  const raw = env[key];

  return typeof raw === "string" ? raw.trim() : "";
}

export function parseAuthConfig(env: Environment): AuthConfig {
  const local = flag(env, "AUTH_LOCAL", true);
  const oidcEnabled = flag(env, "AUTH_OIDC", false);

  if (!local && !oidcEnabled)
    throw new AuthConfigError(
      "At least one of AUTH_LOCAL and AUTH_OIDC must be enabled",
    );
  if (!oidcEnabled) return { local, oidc: null };
  const missing = [
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
  ].filter((key) => !text(env, key));

  if (missing.length)
    throw new AuthConfigError(
      `AUTH_OIDC requires ${missing.join(", ")} to be set`,
    );
  const issuer = text(env, "OIDC_ISSUER");

  try {
    if (!/^https?:$/.test(new URL(issuer).protocol)) throw new Error();
  } catch (error) {
    throw new AuthConfigError("OIDC_ISSUER must be an HTTP(S) URL", {
      cause: error,
    });
  }

  const postLoginPath = text(env, "OIDC_POST_LOGIN_PATH") || "/";

  // Relative, same-origin paths only: never an open redirect.
  if (!postLoginPath.startsWith("/") || /^\/[\\/]/.test(postLoginPath))
    throw new AuthConfigError(
      "OIDC_POST_LOGIN_PATH must be a same-origin path starting with /",
    );

  return {
    local,
    oidc: {
      issuer,
      clientId: text(env, "OIDC_CLIENT_ID"),
      clientSecret: text(env, "OIDC_CLIENT_SECRET"),
      scopes: text(env, "OIDC_SCOPES") || "openid profile email",
      redirectUri: text(env, "OIDC_REDIRECT_URI") || undefined,
      postLoginPath,
    },
  };
}

export function oidcRedirectUri(config: OidcConfig, origin: string) {
  return config.redirectUri || `${origin}/api/auth/oidc/callback`;
}
