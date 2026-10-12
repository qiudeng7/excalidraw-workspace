import { defineApiHandler } from "#server/utils/api";
import { fail } from "#server/utils/http";

// Unmatched API URLs still use the application JSON error contract.
export default defineApiHandler(async () =>
  fail(404, "NOT_FOUND", "接口不存在"),
);
