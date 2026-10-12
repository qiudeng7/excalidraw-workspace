import { collectNodeRoomOrphans } from "./node-cleanup";
import { repairNodeProjections } from "./node-projection";

export default defineNitroPlugin((nitro) => {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void repairNodeProjections()
      .catch((error) =>
        console.error(
          "共享目录投影重试失败",
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
