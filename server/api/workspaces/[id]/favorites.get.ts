import { directoryFavorites } from "#server/db/directory";
import { requireUser } from "#server/utils/auth";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { fail, json } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const result = await directoryFavorites(
    resourceId(event),
    (await requireUser(event)).id,
  );

  if (!result) return fail(404, "NOT_FOUND", "工作区不存在");

  return json(result);
});
