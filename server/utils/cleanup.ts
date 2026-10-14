import { collectRecycleBin } from "#server/utils/recycle-bin";
import type { RoomNamespace } from "#server/collaboration/transport";
import { blob } from "@nuxthub/blob";
import { referencedObjects } from "#server/db/snapshots";
import { deleteSnapshots } from "#server/utils/snapshots";

/** Never collect fresh objects: a write may not have reached its metadata CAS yet. */
export async function collectOrphans(
  now = Date.now(),
  grace = 24 * 60 * 60 * 1000,
) {
  let cursor: string | undefined;

  do {
    const page = await blob.list({ cursor, limit: 100 });
    const candidates = page.blobs.filter((object) => {
      const modified = new Date(object.uploadedAt).getTime();

      return (
        !object.pathname.startsWith("collaboration/") &&
        Number.isFinite(modified) &&
        modified < now - grace &&
        (object.pathname.endsWith(".json") || object.pathname.endsWith(".tmp"))
      );
    });

    // The filesystem SDK lists all files at once; bound SQL parameters and deletes.
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const keys = candidates
        .slice(offset, offset + 100)
        .map((object) => object.pathname);
      const referenced = await referencedObjects(keys);
      const abandoned = keys.filter((key) => !referenced.has(key));

      if (abandoned.length) await deleteSnapshots(abandoned);
    }

    cursor = page.hasMore ? page.cursor : undefined;
    if (page.hasMore && !cursor) throw new Error("Missing blob listing cursor");
  } while (cursor);
}

/** Failures in one storage authority must not suppress the other collector. */
export async function collectStorageGarbage(
  namespace?: RoomNamespace,
  now = Date.now(),
) {
  const results = await Promise.allSettled([
    collectRecycleBin(namespace, now),
    collectOrphans(now),
  ]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );

  if (errors.length)
    throw new AggregateError(errors, "部分存储清理失败，将在下次维护重试");
}
