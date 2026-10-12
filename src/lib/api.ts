export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function conditionalApi<T>(
  path: string,
  options: RequestInit = {},
): Promise<T | undefined> {
  return request<T>(path, options, true);
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  return (await request<T>(path, options, false))!;
}

async function request<T>(
  path: string,
  options: RequestInit,
  conditional: boolean,
): Promise<T | undefined> {
  const headers = new Headers(options.headers);

  if ((options.method ?? "GET").toUpperCase() !== "GET") {
    headers.set("Content-Type", "application/json");
    headers.set("X-Requested-With", "excalidraw-demo");
  }

  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers,
  });

  if (conditional && response.status === 304) return undefined;
  const body = await response.json().catch((error: unknown) => {
    console.warn("API 响应无法解析为 JSON", error);

    return null;
  });

  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.error?.code ?? "REQUEST_FAILED",
      body?.error?.message ?? `请求失败（${response.status}）`,
    );
  }

  if (body === null)
    throw new ApiError(
      response.status,
      "INVALID_RESPONSE",
      "服务返回了无效的 JSON 响应，请重试",
    );

  return body as T;
}
