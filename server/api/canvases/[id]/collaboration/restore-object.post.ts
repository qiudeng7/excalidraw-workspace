import { blob } from "@nuxthub/blob";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { body, json, fail, ApiError } from "#server/utils/http";
import { apiRequest } from "#server/utils/request";
import { digest } from "#server/utils/passwords";
import { canvasCommand } from "#server/collaboration/service";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  await canvasCommand(event, id, { type: "manage" });
  const data = await body(apiRequest(event), 48 * 1024 * 1024);

  if (typeof data.content !== "string")
    return fail(400, "INVALID_BACKUP_OBJECT", "备份对象无效");
  try {
    JSON.parse(data.content);
  } catch (error) {
    throw new ApiError(400, "INVALID_BACKUP_OBJECT", "备份对象不是有效 JSON", {
      cause: error,
    });
  }

  const key = `collaboration/${id}/restores/${await digest(data.content)}.json`;

  await blob.put(key, data.content, { contentType: "application/json" });
  await canvasCommand(event, id, { type: "manage" });

  return json({ key });
});
