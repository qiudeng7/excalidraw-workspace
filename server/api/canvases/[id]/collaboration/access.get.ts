import { defineApiHandler, resourceId } from "../../../../utils/api";
import { json } from "../../../../utils/http";
import { canvasCommand } from "../../../../collaboration/service";

export default defineApiHandler(
  async (event) =>
    json(await canvasCommand(event, resourceId(event), { type: "access" })),
  { public: true },
);
