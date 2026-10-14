import { collectRecycleBin } from "#server/utils/recycle-bin";
import { collectNodeRoomOrphans } from "#server/collaboration/node-cleanup";
import { repairNodeProjections } from "#server/collaboration/node-projection";

export default defineNitroPlugin((nitro) => {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void Promise.allSettled([collectRecycleBin(), repairNodeProjections()])
      .then((results) => {
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );

        if (errors.length) throw new AggregateError(errors, "部分后台维护失败");
      })
      .catch((error) =>
        console.error(
          "回收站与共享目录维护失败",
          error instanceof Error ? error.message : "unknown",
        ),
      )
      .finally(() => {
        running = false;
      });
  }, 60000);

  const cleanup = setInterval(
    () => {
      void collectNodeRoomOrphans().catch((error) =>
        console.error(
          "协作对象清理失败",
          error instanceof Error ? error.message : "unknown",
        ),
      );
    },
    60 * 60 * 1000,
  );

  cleanup.unref();
  timer.unref();
  nitro.hooks.hook("close", () => {
    clearInterval(timer);
    clearInterval(cleanup);
  });
});
