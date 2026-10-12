import { navigation, recordNavigation } from "../db/navigation";
import { defineApiHandler } from "../utils/api";
import { apiRequest } from "../utils/request";
import { requireUser } from "../utils/auth";
import { requireCanvas } from "../utils/access";
import { fail, json, body, validRevision } from "../utils/http";

export default defineApiHandler(async (event) => {
  const req = apiRequest(event);
  const user = await requireUser(event);

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
