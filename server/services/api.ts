import type { RepositoryPort, ObjectStore } from "../storage/repository";
import { ApiError, json } from "./http";
import { dispatchRequest } from "./composition";
/** Platform adapter supplies owned storage and request environment to the application boundary. */
export interface BackendContext {
  repository: RepositoryPort;
  objects: ObjectStore;
  publicOrigin: string;
  clientIp: string;
  waitUntil(promise: Promise<unknown>): void;
}
export async function handleApi(
  req: Request,
  env: BackendContext,
): Promise<Response> {
  try {
    return await dispatchRequest(req, env);
  } catch (error) {
    if (error instanceof ApiError)
      return json(
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    console.error(
      "API operation failed",
      error instanceof Error ? error.message : "unknown",
    );
    return json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "服务暂时不可用，请稍后重试",
        },
      },
      500,
    );
  }
}
