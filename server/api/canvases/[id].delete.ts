import { deleteCanvas } from "#server/db/canvases";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest, runBackground } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { requireWorkspace, requireCanvas } from "#server/utils/access";
import { deleteSnapshots } from "#server/utils/snapshots";
import { fail, json, body, validRevision } from "#server/utils/http";

import { tombstoneCanvas } from "#server/collaboration/service";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  const req = apiRequest(event);
  const user = await requireUser(event);
  const row = await requireCanvas(id, user);

  const ws = await requireWorkspace(row.workspaceId, user);
  const data = req.body ? await body(req) : {};
  const revision = validRevision(data.catalogRevision ?? ws.catalogRevision);

  if (revision !== ws.catalogRevision)
    return fail(409, "CATALOG_CONFLICT", "列表已在其他页面更新，请重新加载");
  await tombstoneCanvas(event, id);
  let committedRevision = revision;
  let result = await deleteCanvas(
    id,
    user.id,
    row.workspaceId,
    committedRevision,
  );

  // A concurrent catalog reorder cannot undo the durable deletion intent.
  for (let attempt = 0; !result.changed && attempt < 10; attempt++) {
    const latest = await requireWorkspace(row.workspaceId, user);

    committedRevision = latest.catalogRevision;
    result = await deleteCanvas(
      id,
      user.id,
      row.workspaceId,
      committedRevision,
    );
  }

  if (!result.changed)
    return fail(409, "CATALOG_CONFLICT", "列表已在其他页面更新，请重新加载");
  if (result.objectKey)
    runBackground(event, deleteSnapshots([result.objectKey]));

  return json({ catalogRevision: committedRevision + 1 });
});
