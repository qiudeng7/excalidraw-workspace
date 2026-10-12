import { defineApiHandler } from "../utils/api";
import { logout } from "../utils/auth";

export default defineApiHandler(
  async (event) => {
    return logout(event);
  },
  { public: true },
);
