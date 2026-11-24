import { defineEventHandler, getRequestURL } from "h3";
import { json } from "#server/utils/http";
import { requestOrigin } from "#server/utils/request";

/**
 * RFC 9728 protected-resource metadata. Identity pulls this to learn the scopes this
 * deployment accepts; the resource identifier must match the origin it is served from.
 */
export default defineEventHandler((event) =>
  json(
    {
      resource: requestOrigin(event),
      authorization_servers: ["https://identity.chongqing-yusheng.cn"],
      scopes_supported: ["excalidraw:canvas.read", "excalidraw:canvas.write"],
      bearer_methods_supported: ["header"],
      resource_name: "Excalidraw Workspace",
    },
    200,
    { "Access-Control-Allow-Origin": "*" },
  ),
);
