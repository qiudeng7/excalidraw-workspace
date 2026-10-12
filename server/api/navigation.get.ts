import { navigation } from "../db/navigation";
import { defineApiHandler } from "../utils/api";
import { requireUser } from "../utils/auth";
import { json } from "../utils/http";

export default defineApiHandler(async (event) => {
  const user = await requireUser(event);

  return json(await navigation(user.id));
});
