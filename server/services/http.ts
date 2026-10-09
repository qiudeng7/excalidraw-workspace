const MAX_BODY = 20 * 1024 * 1024;
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};
export const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
export async function body(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json"))
    fail(415, "JSON_REQUIRED", "请使用 JSON 请求");
  if (Number(req.headers.get("content-length")) > MAX_BODY)
    fail(413, "TOO_LARGE", "单次保存不能超过 20 MB");
  const reader = req.body?.getReader();
  if (!reader) fail(400, "INVALID_BODY", "请求内容为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader!.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader!.cancel();
      fail(413, "TOO_LARGE", "单次保存不能超过 20 MB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isObject(result)) throw Error();
    return result;
  } catch {
    return fail(400, "INVALID_BODY", "请求内容不是有效的 JSON 对象");
  }
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function name(value: unknown, fallback?: string) {
  if (value === undefined && fallback) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100)
    return fail(400, "INVALID_NAME", "名称需为 1–100 个字符");
  return value.trim();
}
export function validRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return fail(400, "INVALID_REVISION", "版本号无效");
  return value;
}

export function assertOrigin(req: Request, publicOrigin: string): void {
  if (
    !["GET", "HEAD"].includes(req.method) &&
    (req.headers.get("origin") !== publicOrigin ||
      req.headers.get("x-requested-with") !== "excalidraw-demo")
  )
    fail(403, "CSRF_REJECTED", "请求来源无效");
}
export function assertOwner(
  req: Request,
  userId: string,
  header: string,
): void {
  const expectedOwner = req.headers.get(header);
  if (expectedOwner && expectedOwner !== userId)
    fail(
      401,
      "SESSION_CHANGED",
      "登录账户已在其他页面更改，请重新登录或刷新页面",
    );
}
