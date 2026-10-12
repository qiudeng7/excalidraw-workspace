import { navigation, recordNavigation } from "#server/db/navigation";
import { defineApiHandler } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { requireCanvas } from "#server/utils/access";
import {
  fail,
  json,
  body,
  validRevision,
  assertOwner,
} from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const req = apiRequest(event);
  const user = await requireUser(event);

  assertOwner(apiRequest(event), user.id, "x-resource-owner");

  const data = await body(req);
  const revision = validRevision(data.revision);

  if (typeof data.canvasId !== "string")
    return fail(400, "INVALID_NAVIGATION", "请选择有效画布");
  await requireCanvas(data.canvasId, user);
  if (!(await recordNavigation(user.id, data.canvasId, revision)))
    return fail(
      409,
      "NAVIGATION_CONFLICT",
      "当前画布已打开，最近位置未更新，请读取最新版本",
    );

  return json(await navigation(user.id));
});
