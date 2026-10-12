import { snapshotValidator } from "#shared/snapshotValidator";
import { library } from "#server/db/snapshots";
import { defineApiHandler } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { readSnapshot } from "#server/utils/snapshots";
import { ApiError, fail, json, assertOwner } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const req = apiRequest(event);
  const user = await requireUser(event);

  assertOwner(req, user.id, "x-resource-owner");
  const row = await library(user.id);

  if (!row) return fail(500, "LIBRARY_MISSING", "素材库未初始化");

  const headers = {
    ETag: snapshotValidator("library", user.id, row.revision),
    "Cache-Control": "no-store",
  };

  if (req.headers.get("if-none-match") === headers.ETag)
    return new Response(null, { status: 304, headers });

  try {
    return json(
      {
        revision: row.revision,
        items: await readSnapshot(row.objectKey, []),
      },
      200,
      headers,
    );
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "STORAGE_UNAVAILABLE")
      throw error;
    const latest = await library(user.id);

    if (!latest) throw error;

    return json(
      {
        revision: latest.revision,
        items: await readSnapshot(latest.objectKey, []),
      },
      200,
      { ETag: snapshotValidator("library", user.id, latest.revision) },
    );
  }
});
