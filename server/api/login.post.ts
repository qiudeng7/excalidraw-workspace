import { userByEmail } from "#server/db/accounts";
import { defineApiHandler } from "#server/utils/api";
import { readAuthCredentials, createSession } from "#server/utils/auth";
import { verifyPassword } from "#server/utils/passwords";
import { fail } from "#server/utils/http";

export default defineApiHandler(
  async (event) => {
    const { email, password } = await readAuthCredentials(event);

    const row = await userByEmail(email);
    const valid = await verifyPassword(
      password,
      row?.passwordHash ??
        `pbkdf2-sha256$100000$${"0".repeat(64)}$${"0".repeat(64)}`,
    );

    if (!row || !valid)
      return fail(401, "INVALID_CREDENTIALS", "邮箱或密码不正确");
    const { passwordHash: _, ...user } = row;

    return createSession(event, user, row.passwordHash);
  },
  { public: true },
);
