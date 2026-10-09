import { handleApi } from "../server/services/api";
import {
  cloudflareStorage,
  type CloudflareBindings,
} from "../server/storage/cloudflare";
import { publicOrigin } from "../server/services/security";
export interface Env extends CloudflareBindings {
  ASSETS: Fetcher;
}
/** Compatibility entry for focused workerd tests; production uses the Nitro Worker. */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    if (!new URL(req.url).pathname.startsWith("/api/"))
      return env.ASSETS.fetch(req);
    return handleApi(req, {
      ...cloudflareStorage(env),
      publicOrigin: publicOrigin(
        env.PUBLIC_ORIGIN,
        req.url,
        !env.PUBLIC_ORIGIN,
      ),
      clientIp: req.headers.get("cf-connecting-ip") || "unknown",
      waitUntil: (p) => ctx.waitUntil(p),
    });
  },
} satisfies ExportedHandler<Env>;
