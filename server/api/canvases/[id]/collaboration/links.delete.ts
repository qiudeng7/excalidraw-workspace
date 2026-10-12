import { defineApiHandler, resourceId } from "../../../../utils/api";
import { body, json, fail } from "../../../../utils/http";
import { apiRequest } from "../../../../utils/request";
import { canvasCommand } from "../../../../collaboration/service";

export default defineApiHandler(async (event) => {
  const data = await body(apiRequest(event));

  if (typeof data.id !== "string") return fail(400, "INVALID_LINK", "链接无效");

  return json(
    await canvasCommand(event, resourceId(event), {
      type: "removeLink",
      id: data.id,
    }),
  );
});
