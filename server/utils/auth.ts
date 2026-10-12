import {
  createSession as storeSession,
  deleteSession,
  purgeExpired,
  rateLimit as incrementRateLimit,
  session,
} from "../db/sessions";
import { getCookie, type H3Event } from "h3";
import type { User } from "../../shared/contracts";
import {
  apiRequest,
  requestOrigin,
  requestClientIp,
  runBackground,
} from "./request";
import { body, fail, json } from "./http";
import { digest, random } from "./passwords";

const SESSION_SECONDS = 60 * 60 * 24 * 14;

declare module "h3" {
  interface H3EventContext {
    currentUser?: Promise<User | null>;
  }
}

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

function sessionToken(event: H3Event) {
  const token = getCookie(event, "excalidraw_session");

  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

/** Cache the identity on Nitro's request event, never in module-global state. */
export function currentUser(event: H3Event): Promise<User | null> {
  return (event.context.currentUser ??= (async () => {
    const token = sessionToken(event);

    if (!token) return null;

    return session(await digest(token), Date.now());
  })());
}

export async function requireUser(event: H3Event): Promise<User> {
  return (await currentUser(event)) ?? fail(401, "UNAUTHENTICATED", "请先登录");
}

export async function createSession(
  event: H3Event,
  user: User,
): Promise<Response> {
  const token = random();

  await storeSession(
    await digest(token),
    user.id,
    Date.now() + SESSION_SECONDS * 1000,
  );

  return json({ user }, 200, {
    "Set-Cookie": cookie(requestOrigin(event), token),
  });
}

export async function logout(event: H3Event): Promise<Response> {
  const token = sessionToken(event);

  if (token) await deleteSession(await digest(token));

  return json({}, 200, { "Set-Cookie": cookie(requestOrigin(event), "", 0) });
}

function cookie(origin: string, token: string, age = SESSION_SECONDS) {
  return `excalidraw_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(origin).protocol === "https:" ? "; Secure" : ""}`;
}

export async function rateLimit(
  event: H3Event,
  key: string,
  limit: number,
  windowSeconds = 900,
): Promise<void> {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const record = await incrementRateLimit(
    `${key}:${bucket}`,
    (bucket + 1) * windowSeconds * 1000,
  );

  if ((record?.count ?? limit + 1) > limit)
    fail(429, "RATE_LIMITED", "尝试过于频繁，请稍后再试");
}

export async function readAuthCredentials(event: H3Event) {
  await rateLimit(event, `auth-ip:${await digest(requestClientIp(event))}`, 40);
  const data = await body(apiRequest(event));
  const result = credentials(data);

  await rateLimit(event, `auth-email:${await digest(result.email)}`, 15);
  runBackground(event, purgeExpired(Date.now()));

  return { data, ...result };
}
