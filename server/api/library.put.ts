import { library } from "#server/db/snapshots";
import { defineApiHandler } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { assertRichTextWrite, libraryElements } from "#server/utils/richText";
import { readSnapshot, saveSnapshot } from "#server/utils/snapshots";
import { fail, json, body, assertOwner } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const req = apiRequest(event);
  const user = await requireUser(event);

  assertOwner(req, user.id, "x-resource-owner");
  const row = await library(user.id);

  if (!row) return fail(500, "LIBRARY_MISSING", "素材库未初始化");

  const data = await body(req);

  if (!Array.isArray(data.items))
    return fail(400, "INVALID_LIBRARY", "素材库数据格式无效");

  assertRichTextWrite(
    libraryElements(data.items),
    libraryElements(await readSnapshot(row.objectKey, [])),
    data.textFormatVersion,
  );

  return json(
    await saveSnapshot(
      event,
      user,
      "library",
      user.id,
      row,
      data.revision,
      data.items,
    ),
  );
});
