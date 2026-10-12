import { defineApiHandler } from "../utils/api";
import { apiRequest } from "../utils/request";
import { requireUser } from "../utils/auth";
import { saveSnapshot } from "../utils/snapshots";
import { fail, json, body, assertOwner } from "../utils/http";

export default defineApiHandler(async (event) => {
  const repository = await event.context.repository();

  const req = apiRequest(event);
  const user = await requireUser(event);

  assertOwner(req, user.id, "x-resource-owner");
  const row = await repository.library(user.id);

  if (!row) return fail(500, "LIBRARY_MISSING", "素材库未初始化");

  const data = await body(req);

  if (!Array.isArray(data.items))
    return fail(400, "INVALID_LIBRARY", "素材库数据格式无效");

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
