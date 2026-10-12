import type { H3Event } from "h3";
import type { User } from "../../shared/contracts";
import { readAuthCredentials, createSession } from "./auth";
import { ApiError, fail, name } from "./http";
import { hashPassword } from "./passwords";

/** Initial setup and registration share account creation and uniqueness rules. */
export async function registerAccount(event: H3Event, role: User["role"]) {
  const repository = await event.context.repository();
  const { data, email, password } = await readAuthCredentials(event);
  const user: User = {
    id: crypto.randomUUID(),
    email,
    name: name(data.name, email.split("@")[0]),
    role: role,
  };
  const now = new Date().toISOString();
  const workspaceId = crypto.randomUUID();

  try {
    const changes = await repository.createAccount(
      user,
      await hashPassword(password),
      workspaceId,
      crypto.randomUUID(),
      now,
    );

    if (!changes)
      return fail(403, "REGISTRATION_DISABLED", "尚未初始化或管理员已关闭注册");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (String(error).includes("UNIQUE constraint failed"))
      return fail(
        409,
        "ACCOUNT_EXISTS",
        user.role === "admin" ? "管理员已创建，请登录" : "邮箱已经注册",
      );
    throw error;
  }

  return createSession(event, user);
}
