import { runBackground } from "../../utils/request";
import { defineApiHandler, resourceId } from "../../utils/api";
import { requireUser } from "../../utils/auth";
import { requireWorkspace } from "../../utils/access";
import { deleteSnapshots, snapshotObjects } from "../../utils/snapshots";
import { json } from "../../utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);
  const repository = await event.context.repository();
  const objects = snapshotObjects(event);

  const user = await requireUser(event);

  await requireWorkspace(repository, id, user);

  const keys = await repository.deleteWorkspace(id, user.id);

  if (keys.length) runBackground(event, deleteSnapshots(objects, keys));

  return json({});
});
