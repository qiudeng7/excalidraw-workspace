import { defineApiHandler } from "../utils/api";
import { apiRequest } from "../utils/request";
import { requireUser } from "../utils/auth";
import { readSnapshot, snapshotObjects } from "../utils/snapshots";
import { ApiError, fail, json, assertOwner } from "../utils/http";

export default defineApiHandler(async (event) => {
  const repository = await event.context.repository();
  const objects = snapshotObjects(event);

  const req = apiRequest(event);
  const user = await requireUser(event);

  assertOwner(req, user.id, "x-resource-owner");
  const row = await repository.library(user.id);

  if (!row) return fail(500, "LIBRARY_MISSING", "素材库未初始化");

  try {
    return json({
      revision: row.revision,
      items: await readSnapshot(objects, row.objectKey, []),
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "STORAGE_UNAVAILABLE")
      throw error;
    const latest = await repository.library(user.id);

    if (!latest) throw error;

    return json({
      revision: latest.revision,
      items: await readSnapshot(objects, latest.objectKey, []),
    });
  }
});
