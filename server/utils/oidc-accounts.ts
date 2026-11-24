import {
  createAccount,
  NO_PASSWORD,
  userByEmail,
  userByIdentity,
} from "#server/db/accounts";
import type { User } from "#shared/contracts";
import { digest } from "#server/utils/passwords";

export interface OidcClaims {
  /** 实际签发方；微软多租户会带租户 id，账号映射按此值保存。 */
  iss?: unknown;
  sub: string;
  email?: unknown;
  name?: unknown;
  preferred_username?: unknown;
  tid?: unknown;
  picture?: unknown;
}

const asText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Pick a free email; a clash with any existing account gets a stable per-identity suffix. */
async function availableEmail(claims: OidcClaims, issuer: string) {
  const suffix = (await digest(`${issuer}\n${claims.sub}`)).slice(0, 8);
  const claimed = asText(claims.email)?.toLowerCase();
  const valid = claimed && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claimed);
  const [local, domain] = valid
    ? [claimed.split("@")[0], claimed.split("@")[1]]
    : [`oidc-${suffix}`, "oidc.invalid"];
  const candidates = [
    `${local}@${domain}`,
    `${local}+oidc-${suffix}@${domain}`,
    `${local}+oidc-${crypto.randomUUID().slice(0, 8)}@${domain}`,
  ].map((email) => email.slice(0, 254));

  for (const email of candidates) if (!(await userByEmail(email))) return email;

  return candidates[2]!;
}

/**
 * Map an (issuer, sub) identity to a new local user on first login.
 * OIDC accounts are always ordinary users: the administrator comes from local setup.
 */
export async function createOidcUser(
  issuer: string,
  claims: OidcClaims,
): Promise<User> {
  const identity = { issuer, subject: claims.sub };
  const fallbackName = asText(claims.email)?.split("@")[0] ?? "OIDC 用户";
  const name = (
    asText(claims.name) ??
    asText(claims.preferred_username) ??
    fallbackName
  ).slice(0, 100);

  // A concurrent first login or email claim can race; retry with fresh state.
  for (let attempt = 0; attempt < 3; attempt++) {
    const user: User = {
      id: crypto.randomUUID(),
      email: await availableEmail(claims, issuer),
      name,
      role: "user",
    };

    try {
      const changes = await createAccount(
        user,
        NO_PASSWORD,
        crypto.randomUUID(),
        crypto.randomUUID(),
        new Date().toISOString(),
        false,
        identity,
      );

      if (changes) return user;
    } catch (error) {
      const winner = await userByIdentity(issuer, claims.sub);

      if (winner) return winner;
      if (!String(error).includes("UNIQUE constraint failed")) throw error;
    }
  }

  const winner = await userByIdentity(issuer, claims.sub);

  if (winner) return winner;
  throw new Error("OIDC account creation failed");
}
