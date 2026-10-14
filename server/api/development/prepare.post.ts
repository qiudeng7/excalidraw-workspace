import {
  developmentAccounts,
  prepareDevelopmentAccounts,
} from "#server/utils/development";
import { defineApiHandler } from "#server/utils/api";
import { fail, json } from "#server/utils/http";

/** Called once by the local launcher, never available on ordinary deployments. */
export default defineApiHandler(
  async (event) => {
    const accounts = developmentAccounts(event);

    if (!accounts) return fail(404, "NOT_FOUND", "接口不存在");
    await prepareDevelopmentAccounts(accounts);

    return json({ ready: true });
  },
  { public: true },
);
