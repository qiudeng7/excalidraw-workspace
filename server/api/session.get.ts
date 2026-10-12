import { defineApiHandler } from "../utils/api";
import { currentUser } from "../utils/auth";
import { json } from "../utils/http";

export default defineApiHandler(
  async (event) => {
    return json({ user: await currentUser(event) });
  },
  { public: true },
);
