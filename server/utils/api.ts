import {
  defineEventHandler,
  getRouterParam,
  sendWebResponse,
  type H3Event,
} from "h3";
import { apiRequest, requestOrigin } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { ApiError, assertOrigin, fail, json } from "#server/utils/http";

/** Retain the existing JSON error contract and default authentication for API routes. */
export function defineApiHandler(
  handler: (event: H3Event) => Promise<Response>,
  options: { public?: boolean } = {},
) {
  return defineEventHandler(async (event) => {
    let response: Response;

    try {
      assertOrigin(apiRequest(event), requestOrigin(event));
      if (!options.public) await requireUser(event);
      response = await handler(event);
    } catch (error) {
      if (error instanceof ApiError) {
        response = json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      } else {
        console.error(
          "API operation failed",
          error instanceof Error ? error.message : "unknown",
        );
        response = json(
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

    return sendWebResponse(event, response);
  });
}

export function resourceId(event: H3Event): string {
  const id = getRouterParam(event, "id", { decode: true });

  if (!id) return fail(400, "INVALID_ID", "资源标识无效");

  return id;
}
