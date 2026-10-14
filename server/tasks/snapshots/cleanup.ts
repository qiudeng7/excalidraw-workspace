import { collectRecycleBin } from "#server/utils/recycle-bin";
import type { RoomNamespace } from "#server/collaboration/transport";
import { collectOrphans } from "#server/utils/cleanup";

export default defineTask({
  meta: { description: "Reclaim unreferenced snapshots older than 24 hours" },
  async run({ context }) {
    const cloudflare = (
      context as { cloudflare?: { env?: { CANVAS_ROOMS?: RoomNamespace } } }
    ).cloudflare;

    await collectRecycleBin(cloudflare?.env?.CANVAS_ROOMS);
    await collectOrphans();

    return { result: "complete" };
  },
});
