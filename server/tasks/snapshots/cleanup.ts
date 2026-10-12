import { collectOrphans } from "#server/utils/cleanup";

export default defineTask({
  meta: { description: "Reclaim unreferenced snapshots older than 24 hours" },
  async run() {
    await collectOrphans();

    return { result: "complete" };
  },
});
