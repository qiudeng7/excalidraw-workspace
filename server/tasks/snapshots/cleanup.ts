import type { RoomNamespace } from "#server/collaboration/transport";
import { collectStorageGarbage } from "#server/utils/cleanup";

export default defineTask({
  meta: {
    description: "Purge expired recycle entries and unreferenced snapshots",
  },
  async run({ context }) {
    const cloudflare = (
      context as { cloudflare?: { env?: { CANVAS_ROOMS?: RoomNamespace } } }
    ).cloudflare;

    await collectStorageGarbage(cloudflare?.env?.CANVAS_ROOMS);

    return { result: "complete" };
  },
});
