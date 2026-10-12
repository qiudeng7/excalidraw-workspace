import { navigation } from "#server/db/navigation";
import { defineApiHandler } from "#server/utils/api";
import { requireUser } from "#server/utils/auth";
import { apiRequest } from "#server/utils/request";
import { json, assertOwner } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const user = await requireUser(event);

  assertOwner(apiRequest(event), user.id, "x-resource-owner");

  return json(await navigation(user.id));
});
