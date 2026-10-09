import type { User } from "../../../shared/contracts";
import type { RepositoryPort } from "../../storage/repository";
import type { Authentication } from "../auth";
import { credentials } from "../auth";
import { ApiError, fail, json, body, name } from "../http";
import { digest, hashPassword, verifyPassword } from "../passwords";
import type { RouteHandler } from "../routing";
export interface AccountsRoutesDependencies {
  request: Request;
  repository: Pick<
    RepositoryPort,
    | "administrator"
    | "registration"
    | "userByEmail"
    | "createAccount"
    | "purgeExpired"
  >;
  authentication: Authentication;
  clientIp: string;
  waitUntil: (promise: Promise<unknown>) => void;
}
export function createAccountsRoutes({
  request,
  repository,
  authentication,
  clientIp,
  waitUntil,
}: AccountsRoutesDependencies): RouteHandler {
  return {
    async handle() {
      const req = request;
      const path = new URL(req.url).pathname;
      const method = req.method;
      if (path === "/api/bootstrap" && method === "GET") {
        const admin = await repository.administrator();
        const settings = await repository.registration();
        return json({
          needsSetup: !admin,
          registrationEnabled: !!settings?.registration_enabled,
          emailVerification: false,
        });
      }
      if (path === "/api/session" && method === "GET")
        return json({ user: await authentication.currentUser() });
      if (
        ["/api/setup", "/api/register", "/api/login"].includes(path) &&
        method === "POST"
      ) {
        await authentication.rateLimit(`auth-ip:${await digest(clientIp)}`, 40);
        const data = await body(req);
        const { email, password } = credentials(data);
        await authentication.rateLimit(`auth-email:${await digest(email)}`, 15);
        waitUntil(repository.purgeExpired(Date.now()));
        if (path === "/api/login") {
          const row = await repository.userByEmail(email);
          const valid = await verifyPassword(
            password,
            row?.password_hash ??
              `pbkdf2-sha256$100000$${"0".repeat(64)}$${"0".repeat(64)}`,
          );
          if (!row || !valid)
            return fail(401, "INVALID_CREDENTIALS", "邮箱或密码不正确");
          const { password_hash: _, ...user } = row;
          return authentication.createSession(user);
        }
        const user: User = {
          id: crypto.randomUUID(),
          email,
          name: name(data.name, email.split("@")[0]),
          role: path === "/api/setup" ? "admin" : "user",
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
            return fail(
              403,
              "REGISTRATION_DISABLED",
              "尚未初始化或管理员已关闭注册",
            );
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
        return authentication.createSession(user);
      }
      if (path === "/api/logout" && method === "POST")
        return authentication.logout();

      return undefined;
    },
  };
}
