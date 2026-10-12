import { db } from "@nuxthub/db";
import { eq } from "drizzle-orm";
import { canvases, sharedCanvases } from "#server/db/schema";
import { defineApiHandler } from "#server/utils/api";
import { requireUser } from "#server/utils/auth";
import { ApiError, json } from "#server/utils/http";
import { canvasCommand } from "#server/collaboration/service";
import type { CanvasView } from "#shared/collaboration/types";

export default defineApiHandler(async (event) => {
  const user = await requireUser(event);
  const rows = await db
    .select({ id: canvases.id })
    .from(sharedCanvases)
    .innerJoin(canvases, eq(sharedCanvases.canvasId, canvases.id))
    .where(eq(sharedCanvases.userId, user.id));
  const result = [];

  for (const row of rows) {
    try {
      const view = await canvasCommand<CanvasView>(event, row.id, {
        type: "view",
      });

      result.push({
        id: row.id,
        name: view.name,
        role: view.access.role,
        viewMode: view.access.viewMode,
      });
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        ![401, 403, 404, 410].includes(error.status)
      )
        throw error;
    }
  }

  return json({ canvases: result });
});
