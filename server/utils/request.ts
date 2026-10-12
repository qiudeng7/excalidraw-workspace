import { getRequestURL, toWebRequest, type H3Event } from "h3";
import { clientIp, publicOrigin } from "./security";

declare module "h3" {
  interface H3EventContext {
    workspaceRequest?: Request;
  }
}

export function apiRequest(event: H3Event): Request {
  const cf = event.context.cloudflare;

  // Nitro 2 buffers POST/PUT/PATCH only. Preserve DELETE's original Worker body.
  return (event.context.workspaceRequest ??=
    event.method === "DELETE" && cf?.request
      ? (cf.request as Request)
      : toWebRequest(event));
}

/** Keep configured origins authoritative for CSRF checks and Secure cookies. */
export function requestOrigin(event: H3Event): string {
  return publicOrigin(
    useRuntimeConfig(event).publicOrigin ||
      event.context.cloudflare?.env?.PUBLIC_ORIGIN ||
      process.env.PUBLIC_ORIGIN,
    getRequestURL(event).href,
    import.meta.dev,
  );
}

export function requestClientIp(event: H3Event): string {
  if (event.context.cloudflare)
    return event.headers.get("cf-connecting-ip") || "unknown";

  return clientIp(
    event.node.req.socket.remoteAddress,
    event.headers.get("x-forwarded-for"),
    useRuntimeConfig(event).trustedProxyIps || process.env.TRUSTED_PROXY_IPS,
  );
}

/** Native request lifetime with a shared background-error logging policy. */
export function runBackground(event: H3Event, promise: Promise<unknown>): void {
  event.waitUntil(
    promise.catch((error) =>
      console.error(
        "Background operation failed",
        error instanceof Error ? error.message : "unknown",
      ),
    ),
  );
}
