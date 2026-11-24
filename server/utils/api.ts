import {
  defineEventHandler,
  getRouterParam,
  sendWebResponse,
  type H3Event,
} from "h3";
import {
  apiRequest,
  requestCorsOrigins,
  requestOrigin,
} from "#server/utils/request";
import { requireUser, type BearerScope } from "#server/utils/auth";
import { authConfig } from "#server/utils/auth-methods";
import { ApiError, assertOrigin, fail, json } from "#server/utils/http";

/** Read-only methods only need the read scope; anything else mutates state. */
function scopeFor(method: string, override?: BearerScope): BearerScope {
  if (override) return override;

  return method === "GET" || method === "HEAD" ? "read" : "write";
}

/** Retain the existing JSON error contract and default authentication for API routes. */
export function defineApiHandler(
  handler: (event: H3Event) => Promise<Response>,
  options: { public?: boolean; scope?: BearerScope } = {},
) {
  return defineEventHandler(async (event) => {
    let response: Response;

    try {
      assertOrigin(
        apiRequest(event),
        requestOrigin(event),
        requestCorsOrigins(event),
      );
      // Misconfiguration must fail loudly on Workers, where env arrives per request.
      authConfig(event);
      if (!options.public)
        await requireUser(event, scopeFor(event.method, options.scope));
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
