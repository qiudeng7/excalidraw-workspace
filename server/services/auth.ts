import type { User } from "../../shared/contracts";
import type { RepositoryPort } from "../storage/repository";
import { fail, json } from "./http";
import { digest, random } from "./passwords";
const SESSION_SECONDS = 60 * 60 * 24 * 14;
export function credentials(data: Record<string, unknown>) {
  if (
    typeof data.email !== "string" ||
    data.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())
  )
    fail(400, "INVALID_EMAIL", "请输入有效邮箱");
  if (
    typeof data.password !== "string" ||
    data.password.length < 12 ||
    data.password.length > 256
  )
    fail(400, "INVALID_PASSWORD", "密码需为 12–256 个字符");
  return {
    email: String(data.email).trim().toLowerCase(),
    password: String(data.password),
  };
}
function cookie(origin: string, token: string, age = SESSION_SECONDS) {
  return `excalidraw_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(origin).protocol === "https:" ? "; Secure" : ""}`;
}
function sessionToken(req: Request) {
  return req.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)excalidraw_session=([a-f0-9]{64})(?:;|$)/)?.[1];
}

export interface Authentication {
  currentUser(): Promise<User | null>;
  requireUser(): Promise<User>;
  createSession(user: User): Promise<Response>;
  logout(): Promise<Response>;
  rateLimit(key: string, limit: number, windowSeconds?: number): Promise<void>;
}
export interface AuthDependencies {
  repository: Pick<
    RepositoryPort,
    "session" | "createSession" | "deleteSession" | "rateLimit"
  >;
  request: Request;
  publicOrigin: string;
}
export function createAuthentication({
  repository,
  request,
  publicOrigin,
}: AuthDependencies): Authentication {
  let identity: Promise<User | null> | undefined;
  return {
    currentUser() {
      const token = sessionToken(request);
      return (identity ??= token
        ? digest(token).then((hash) => repository.session(hash, Date.now()))
        : Promise.resolve(null));
    },
    async requireUser() {
      return (
        (await this.currentUser()) ?? fail(401, "UNAUTHENTICATED", "请先登录")
      );
    },
    async createSession(user) {
      const token = random();
      await repository.createSession(
        await digest(token),
        user.id,
        Date.now() + SESSION_SECONDS * 1000,
      );
      return json({ user }, 200, { "Set-Cookie": cookie(publicOrigin, token) });
    },
    async logout() {
      const token = sessionToken(request);
      if (token) await repository.deleteSession(await digest(token));
      return json({}, 200, { "Set-Cookie": cookie(publicOrigin, "", 0) });
    },
    async rateLimit(key, limit, windowSeconds = 900) {
      const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
      const record = await repository.rateLimit(
        `${key}:${bucket}`,
        (bucket + 1) * windowSeconds * 1000,
      );
      if ((record?.count ?? limit + 1) > limit)
        fail(429, "RATE_LIMITED", "尝试过于频繁，请稍后再试");
    },
  };
}
