import { defineApiHandler } from "#server/utils/api";
import { registerAccount } from "#server/utils/accounts";

export default defineApiHandler((event) => registerAccount(event, "admin"), {
  public: true,
});
