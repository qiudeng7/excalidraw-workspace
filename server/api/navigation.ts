import { defineApiHandler } from "../utils/api";
import { fail } from "../utils/http";

export default defineApiHandler(async () =>
  fail(405, "METHOD_NOT_ALLOWED", "请求方法不支持"),
);
