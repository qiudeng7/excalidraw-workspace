import { defineApiHandler, resourceId } from "#server/utils/api";
import { json } from "#server/utils/http";
import { canvasCommand } from "#server/collaboration/service";

export default defineApiHandler(async (event) =>
  json(await canvasCommand(event, resourceId(event), { type: "manage" })),
);
