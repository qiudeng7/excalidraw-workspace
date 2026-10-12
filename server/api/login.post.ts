import { defineApiHandler } from "../utils/api";
import { readAuthCredentials, createSession } from "../utils/auth";
import { verifyPassword } from "../utils/passwords";
import { fail } from "../utils/http";

export default defineApiHandler(
  async (event) => {
    const repository = await event.context.repository();
    const { email, password } = await readAuthCredentials(event);

    const row = await repository.userByEmail(email);
    const valid = await verifyPassword(
      password,
      row?.password_hash ??
        `pbkdf2-sha256$100000$${"0".repeat(64)}$${"0".repeat(64)}`,
    );

    if (!row || !valid)
      return fail(401, "INVALID_CREDENTIALS", "邮箱或密码不正确");
    const { password_hash: _, ...user } = row;

    return createSession(event, user);
  },
  { public: true },
);
