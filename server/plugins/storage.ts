import { nodeObjectDriver, nodeStorage } from "#workspace-node-storage";
import { workspaceR2Driver } from "../storage/r2";
import {
  cloudflareRepository,
  cloudflareObjects,
  type CloudflareBindings,
} from "../storage/cloudflare";
import { collectOrphans } from "../storage/repository";
import type { RepositoryPort } from "../storage/ports";
import { runBackground } from "../utils/request";

export default defineNitroPlugin((nitro) => {
  const isWorker = useRuntimeConfig().workspacePlatform === "cloudflare";

  useStorage().mount(
    "objects",
    isWorker ? workspaceR2Driver() : nodeObjectDriver(),
  );

  let local: ReturnType<typeof nodeStorage> | undefined;
  let lastCloudflareSweep = 0;
  const initialize = () => {
    local ??= nodeStorage(undefined, undefined, {
      database: useDatabase(),
      storage: useStorage("objects"),
    }).catch((error) => {
      local = undefined;
      throw error;
    });

    return local;
  };

  nitro.hooks.hook("request", (event) => {
    if (!event.path.startsWith("/api/")) return;
    let repository: Promise<RepositoryPort> | undefined;

    event.context.repository = () =>
      (repository ??= (async () => {
        if (!isWorker) return (await initialize()).repository;
        const cf = event.context.cloudflare as
          { env: CloudflareBindings } | undefined;

        if (!cf?.env?.DB || !cf.env.DATA)
          throw new Error("Missing Cloudflare storage bindings");
        const database =
          (await useDatabase().getInstance()) as CloudflareBindings["DB"];
        const result = cloudflareRepository(database);

        if (Date.now() - lastCloudflareSweep > 60 * 60 * 1000) {
          lastCloudflareSweep = Date.now();
          runBackground(
            event,
            collectOrphans(
              result,
              cloudflareObjects(cf.env.DATA, useStorage("objects")),
            ),
          );
        }

        return result;
      })());
  });

  if (!isWorker)
    nitro.hooks.hook("close", async () => {
      if (local) (await local).close();
      await useDatabase().dispose();
    });
});
