import {
  defineEventHandler,
  getHeader,
  sendNoContent,
  setResponseHeaders,
} from "h3";
import { requestCorsOrigins } from "#server/utils/request";

/** Every custom request header the frontend sends; tests/unit/cors-headers keeps this in sync. */
export const ALLOWED_REQUEST_HEADERS = [
  "Authorization",
  "Content-Type",
  "X-Requested-With",
  "X-Canvas-Access",
  "X-Account-Owner",
  "X-Resource-Owner",
  "X-Settings-Owner",
];
const ALLOWED_HEADERS = ALLOWED_REQUEST_HEADERS.join(", ");

/**
 * Cross-origin hosts (a Module Federation shell) get explicit CORS on /api only.
 * No credentials are allowed: browsers must present an Identity access token instead
 * of an Excalidraw session cookie, so the Cookie stays SameSite=Strict.
 */
export default defineEventHandler((event) => {
  if (!event.path.startsWith("/api/")) return;
  const origin = getHeader(event, "origin");

  if (!origin || !requestCorsOrigins(event).includes(origin)) return;
  setResponseHeaders(event, {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods":
      "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  });

  if (event.method === "OPTIONS") return sendNoContent(event, 204);
});
