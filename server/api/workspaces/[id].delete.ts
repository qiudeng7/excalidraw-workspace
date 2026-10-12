import { deleteWorkspace } from "../../db/workspaces";
import { runBackground } from "../../utils/request";
import { defineApiHandler, resourceId } from "../../utils/api";
import { requireUser } from "../../utils/auth";
import { requireWorkspace } from "../../utils/access";
import { deleteSnapshots } from "../../utils/snapshots";
import { json } from "../../utils/http";

import { db } from "@nuxthub/db";
import { eq } from "drizzle-orm";
import { canvases, workspaces } from "../../db/schema";
import { tombstoneCanvas } from "../../collaboration/service";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  const user = await requireUser(event);

  await requireWorkspace(id, user);

  await db.update(workspaces).set({ deleting: 1 }).where(eq(workspaces.id, id));
  const children = await db
    .select({ id: canvases.id })
    .from(canvases)
    .where(eq(canvases.workspaceId, id));

  for (const child of children) await tombstoneCanvas(event, child.id);
  const keys = await deleteWorkspace(id, user.id);

  if (keys.length) runBackground(event, deleteSnapshots(keys));

  return json({});
});
