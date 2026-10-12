import { defineApiHandler } from "#server/utils/api";
import { currentUser } from "#server/utils/auth";
import { json } from "#server/utils/http";

export default defineApiHandler(
  async (event) => {
    return json({ user: await currentUser(event) });
  },
  { public: true },
);
