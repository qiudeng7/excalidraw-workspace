import { defineApiHandler, resourceId } from "#server/utils/api";
import { apiRequest } from "#server/utils/request";
import { requireUser } from "#server/utils/auth";
import { requireCanvas } from "#server/utils/access";
import { assertRichTextWrite } from "#server/utils/richText";
import { readSnapshot, saveSnapshot } from "#server/utils/snapshots";
import { fail, json, body, isObject, assertOwner } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  const req = apiRequest(event);
  const user = await requireUser(event);

  assertOwner(req, user.id, "x-resource-owner");
  const row = await requireCanvas(id, user);

  if (row.syncMode !== "legacy")
    return fail(
      409,
      "COLLAB_PROTOCOL_REQUIRED",
      "此画布已启用协作，请刷新页面后使用协作编辑器",
    );

  const data = await body(req);
  const scene = data.scene;

  if (
    !isObject(scene) ||
    !Array.isArray(scene.elements) ||
    !isObject(scene.appState) ||
    !isObject(scene.files)
  )
    return fail(400, "INVALID_SCENE", "画布数据格式无效");

  const current = await readSnapshot(row.objectKey, { elements: [] });

  assertRichTextWrite(
    scene.elements,
    isObject(current) && Array.isArray(current.elements)
      ? current.elements
      : [],
    data.textFormatVersion,
  );

  return json(
    await saveSnapshot(event, user, "canvas", id, row, data.revision, scene),
  );
});
