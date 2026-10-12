import { defineApiHandler } from "../utils/api";
import { registerAccount } from "../utils/accounts";

export default defineApiHandler((event) => registerAccount(event, "admin"), {
  public: true,
});
