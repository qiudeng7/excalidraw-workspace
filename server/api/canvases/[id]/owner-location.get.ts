import { defineApiHandler, resourceId } from "#server/utils/api";
import { json } from "#server/utils/http";
import { canvasRow, principal } from "#server/collaboration/service";

// This probe never activates storage and never exposes another owner's directory.
export default defineApiHandler(async (event) => {
  const actor = await principal(event);
  const row = await canvasRow(resourceId(event));

  if (!row || row.canvas.deletedAt || row.deleting || row.workspaceDeletedAt)
    return json({});

  return json(
    actor.userId === row.ownerId &&
      !actor.capabilityHash &&
      row.canvas.syncMode === "legacy"
      ? { workspaceId: row.canvas.workspaceId, canvasId: row.canvas.id }
      : {},
  );
});
