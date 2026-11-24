import {
  defineEventHandler,
  getHeader,
  sendNoContent,
  setResponseHeaders,
} from "h3";
import { requestCorsOrigins } from "#server/utils/request";

const ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "X-Requested-With",
  "X-Canvas-Access",
  "X-Account-Owner",
].join(", ");

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
