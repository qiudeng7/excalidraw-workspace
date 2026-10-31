import { reorderDirectoryFavorites } from "#server/db/directory";
import type { NodeRef } from "#shared/directory-contracts";
import { requireUser } from "#server/utils/auth";
import { requireWorkspace } from "#server/utils/access";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { body, fail, json, validRevision } from "#server/utils/http";

const nodeRef = (value: unknown): NodeRef | null => {
  if (!value || typeof value !== "object") return null;
  const ref = value as Record<string, unknown>;

  return (ref.kind === "folder" || ref.kind === "canvas") &&
    typeof ref.id === "string" &&
    ref.id
    ? { kind: ref.kind, id: ref.id }
    : null;
};

export default defineApiHandler(async (event) => {
  const workspaceId = resourceId(event);
  const user = await requireUser(event);

  await requireWorkspace(workspaceId, user);
  const data = await body(apiRequest(event));
  const source = nodeRef(data.source);
  const target = nodeRef(data.target);

  if (
    !source ||
    !target ||
    (data.placement !== "before" && data.placement !== "after")
  )
    return fail(400, "INVALID_FAVORITE_ORDER", "收藏排序参数无效");
  const result = await reorderDirectoryFavorites(
    workspaceId,
    user.id,
    source,
    target,
    data.placement,
    validRevision(data.catalogRevision),
  );

  if (!result)
    return fail(409, "CATALOG_CONFLICT", "收藏列表已更新或项目不可用");

  return json(result);
});
