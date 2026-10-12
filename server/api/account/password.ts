import { defineApiHandler } from "#server/utils/api";
import { fail } from "#server/utils/http";

export default defineApiHandler(async () =>
  fail(405, "METHOD_NOT_ALLOWED", "请求方法不支持"),
);
