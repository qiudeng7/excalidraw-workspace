import { defineApiHandler, resourceId } from "../../../../utils/api";
import { json } from "../../../../utils/http";
import { canvasCommand, hydrateView } from "../../../../collaboration/service";
import type { CanvasView } from "../../../../../shared/collaboration/types";

export default defineApiHandler(
  async (event) =>
    json(
      await hydrateView(
        await canvasCommand<CanvasView>(event, resourceId(event), {
          type: "view",
        }),
      ),
    ),
  { public: true },
);
