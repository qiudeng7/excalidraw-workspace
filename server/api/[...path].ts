import { defineEventHandler, toWebRequest, sendWebResponse } from "h3";
import { handleApi } from "../services/api";
import { clientIp, publicOrigin } from "../services/security";
import {
  cloudflareStorage,
  type CloudflareBindings,
} from "../storage/cloudflare";
import {
  collectOrphans,
  type Repository,
  type ObjectStore,
} from "../storage/repository";
let local:
  | Promise<{
      repository: Repository;
      objects: ObjectStore;
    }>
  | undefined;
let lastCloudflareSweep = 0;
export default defineEventHandler(async (event) => {
  try {
    const cf = event.context.cloudflare as
      | {
          env: CloudflareBindings;
          request?: Request;
          context?: {
            waitUntil(p: Promise<unknown>): void;
          };
        }
      | undefined;
    // Nitro 2's Cloudflare adapter buffers only POST/PUT/PATCH. Its virtual Node
    // stream never ends for DELETE bodies; read the untouched platform request.
    // Other methods must use the reconstructed request because Nitro consumed them.
    const request =
      event.method === "DELETE" && cf?.request
        ? cf.request
        : toWebRequest(event);
    if (cf) {
      if (!cf.env?.DB || !cf.env.DATA)
        throw new Error("Missing Cloudflare storage bindings");
      const storage = cloudflareStorage(cf.env);
      const waitUntil = (promise: Promise<unknown>) => {
        const safe = promise.catch((error) =>
          console.error(
            "Background operation failed",
            error instanceof Error ? error.message : "unknown",
          ),
        );
        if (cf.context) cf.context.waitUntil(safe);
      };
      if (Date.now() - lastCloudflareSweep > 60 * 60 * 1000) {
        lastCloudflareSweep = Date.now();
        waitUntil(collectOrphans(storage.repository, storage.objects));
      }
      return sendWebResponse(
        event,
        await handleApi(request, {
          ...storage,
          publicOrigin: publicOrigin(
            cf.env.PUBLIC_ORIGIN,
            request.url,
            import.meta.dev,
          ),
          clientIp: request.headers.get("cf-connecting-ip") || "unknown",
          waitUntil,
        }),
      );
    }
    // Nitro alias includes SQLite only in the Node artifact; the Workers alias fails closed.
    local ??= import("#workspace-node-storage")
      .then((module) => module.nodeStorage())
      .catch((error) => {
        local = undefined;
        throw error;
      });
    const storage = await local;
    const pending: Promise<unknown>[] = [];
    const response = await handleApi(request, {
      ...storage,
      publicOrigin: publicOrigin(
        process.env.PUBLIC_ORIGIN,
        request.url,
        import.meta.dev,
      ),
      clientIp: clientIp(
        event.node.req.socket.remoteAddress,
        request.headers.get("x-forwarded-for"),
        process.env.TRUSTED_PROXY_IPS,
      ),
      waitUntil(p) {
        pending.push(
          p.catch((error) =>
            console.error(
              "Background operation failed",
              error instanceof Error ? error.message : "unknown",
            ),
          ),
        );
      },
    });
    // Node has no Worker lifetime extension. Finish durable cleanup before responding.
    await Promise.all(pending);
    return sendWebResponse(event, response);
  } catch (error) {
    console.error(
      "API initialization failed",
      error instanceof Error ? error.message : "unknown",
    );
    return sendWebResponse(
      event,
      Response.json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "服务暂时不可用，请稍后重试",
          },
        },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      ),
    );
  }
});
