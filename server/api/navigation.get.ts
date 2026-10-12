import { navigation } from "../db/navigation";
import { defineApiHandler } from "../utils/api";
import { requireUser } from "../utils/auth";
import { apiRequest } from "../utils/request";
import { json, assertOwner } from "../utils/http";

export default defineApiHandler(async (event) => {
  const user = await requireUser(event);

  assertOwner(apiRequest(event), user.id, "x-resource-owner");

  return json(await navigation(user.id));
});
