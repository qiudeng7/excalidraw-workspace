import { blob } from "@nuxthub/blob";
import { referencedObjects } from "../db/snapshots";
import { deleteSnapshots } from "./snapshots";

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
