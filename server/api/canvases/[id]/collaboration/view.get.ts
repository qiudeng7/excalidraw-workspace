import { defineApiHandler, resourceId } from "#server/utils/api";
import { json } from "#server/utils/http";
import { canvasCommand, hydrateView } from "#server/collaboration/service";
import type { CanvasView } from "#shared/collaboration/types";

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
