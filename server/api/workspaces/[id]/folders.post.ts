import { createDirectoryFolder, directoryItem } from "#server/db/directory";
import { requireWorkspace } from "#server/utils/access";
import { requireUser } from "#server/utils/auth";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { body, fail, json, name, validRevision } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const workspaceId = resourceId(event);
  const user = await requireUser(event);

  await requireWorkspace(workspaceId, user);

  const data = await body(apiRequest(event));
  const parentId = data.parentId;

  if (parentId !== null && typeof parentId !== "string")
    return fail(400, "INVALID_DIRECTORY_PARENT", "目录父级无效");
  if (
    parentId &&
    !(await directoryItem(workspaceId, user.id, {
      kind: "folder",
      id: parentId,
    }))
  )
    return fail(404, "NOT_FOUND", "文件夹不存在");

  const catalogRevision = validRevision(data.catalogRevision);
  const id = crypto.randomUUID();
  const revision = await createDirectoryFolder(
    id,
    workspaceId,
    user.id,
    parentId,
    name(data.name),
    new Date().toISOString(),
    catalogRevision,
  );

  if (revision === null)
    return fail(409, "CATALOG_CONFLICT", "目录已在其他页面更新，请重新加载");

  const item = await directoryItem(workspaceId, user.id, {
    kind: "folder",
    id,
  });

  if (!item || item.kind !== "folder")
    return fail(500, "DIRECTORY_WRITE_FAILED", "文件夹创建失败");

  return json({ item, catalogRevision: revision });
});
