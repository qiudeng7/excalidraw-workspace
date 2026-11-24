/**
 * 账号方式配置。OIDC 身份源改由数据库动态配置，环境变量只保留本地账号开关。
 * AUTH_LOCAL=false 时仍可登录的前提是表里已有启用的身份源；这里不做联动校验。
 */
export interface AuthConfig {
  local: boolean;
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

export function parseAuthConfig(env: Environment): AuthConfig {
  return { local: flag(env, "AUTH_LOCAL", true) };
}
