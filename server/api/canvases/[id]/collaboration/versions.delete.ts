import { defineApiHandler, resourceId } from "#server/utils/api";
import { body, json, fail } from "#server/utils/http";
import { apiRequest } from "#server/utils/request";
import { canvasCommand } from "#server/collaboration/service";

export default defineApiHandler(async (event) => {
  const data = await body(apiRequest(event));

  if (typeof data.id !== "string")
    return fail(400, "INVALID_VERSION", "版本标识无效");

  return json(
    await canvasCommand(event, resourceId(event), {
      type: "removeVersion",
      id: data.id,
    }),
  );
});
