import { defineApiHandler, resourceId } from "../../utils/api";
import { requireUser } from "../../utils/auth";
import { requireCanvas } from "../../utils/access";
import { meta, readSnapshot, snapshotObjects } from "../../utils/snapshots";
import { ApiError, json } from "../../utils/http";

const EMPTY_SCENE = { elements: [], appState: {}, files: {} };

export default defineApiHandler(async (event) => {
  const id = resourceId(event);
  const repository = await event.context.repository();
  const objects = snapshotObjects(event);

  const user = await requireUser(event);
  const row = await requireCanvas(repository, id, user);

  try {
    return json({
      canvas: {
        ...meta(row),
        scene: await readSnapshot(objects, row.objectKey, EMPTY_SCENE),
      },
    });
  } catch (error) {
    // An autosave may have replaced and removed this immutable object after the D1 read.
    if (!(error instanceof ApiError) || error.code !== "STORAGE_UNAVAILABLE")
      throw error;
    const latest = await requireCanvas(repository, id, user);

    return json({
      canvas: {
        ...meta(latest),
        scene: await readSnapshot(objects, latest.objectKey, EMPTY_SCENE),
      },
    });
  }
});
