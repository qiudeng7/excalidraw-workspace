import {
  defineEventHandler,
  getHeader,
  sendNoContent,
  setResponseHeaders,
} from "h3";
import { requestCorsOrigins } from "#server/utils/request";

const DEFAULT_ALLOWED_HEADERS =
  "Authorization, Content-Type, X-Requested-With, X-Canvas-Access, X-Account-Owner, X-Resource-Owner, X-Settings-Owner";

/**
 * Cross-origin hosts (a Module Federation shell) get explicit CORS on /api only.
 * No credentials are allowed: browsers must present an Identity access token instead
 * of an Excalidraw session cookie, so the Cookie stays SameSite=Strict.
 *
 * A registered origin is fully trusted for request headers: the preflight echoes whatever
 * it asks for, so browser-added headers (If-None-Match, ...) and new custom headers never
 * need a code change. Authorization still comes only from the bearer token check.
 */
export default defineEventHandler((event) => {
  if (!event.path.startsWith("/api/")) return;
  const origin = getHeader(event, "origin");

  if (!origin || !requestCorsOrigins(event).includes(origin)) return;
  setResponseHeaders(event, {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods":
      "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      getHeader(event, "access-control-request-headers") ||
      DEFAULT_ALLOWED_HEADERS,
    "Access-Control-Max-Age": "600",
    Vary: "Origin, Access-Control-Request-Headers",
  });

  if (event.method === "OPTIONS") return sendNoContent(event, 204);
});
