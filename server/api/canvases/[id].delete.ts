import { defineApiHandler, resourceId } from "../../utils/api";
import { apiRequest, runBackground } from "../../utils/request";
import { requireUser } from "../../utils/auth";
import { requireWorkspace, requireCanvas } from "../../utils/access";
import { deleteSnapshots, snapshotObjects } from "../../utils/snapshots";
import { fail, json, body, validRevision } from "../../utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);
  const repository = await event.context.repository();
  const objects = snapshotObjects(event);

  const req = apiRequest(event);
  const user = await requireUser(event);
  const row = await requireCanvas(repository, id, user);

  const ws = await requireWorkspace(repository, row.workspaceId, user);
  const data = req.body ? await body(req) : {};
  const revision = validRevision(data.catalogRevision ?? ws.catalogRevision);
  const result = await repository.deleteCanvas(
    id,
    user.id,
    row.workspaceId,
    revision,
  );

  if (!result.changed)
    return fail(409, "CATALOG_CONFLICT", "列表已在其他页面更新，请重新加载");
  if (result.objectKey)
    runBackground(event, deleteSnapshots(objects, [result.objectKey]));

  return json({ catalogRevision: revision + 1 });
});
