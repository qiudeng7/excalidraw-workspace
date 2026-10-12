import { defineApiHandler } from "../utils/api";
import { requireUser } from "../utils/auth";
import { json } from "../utils/http";

export default defineApiHandler(async (event) => {
  const repository = await event.context.repository();

  const user = await requireUser(event);

  return json(await repository.navigation(user.id));
});
