import { defineApiHandler } from "#server/utils/api";
import { logout } from "#server/utils/auth";

export default defineApiHandler(
  async (event) => {
    return logout(event);
  },
  { public: true },
);
