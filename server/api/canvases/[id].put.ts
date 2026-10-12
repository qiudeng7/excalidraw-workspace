import { defineApiHandler, resourceId } from "../../utils/api";
import { apiRequest } from "../../utils/request";
import { requireUser } from "../../utils/auth";
import { requireCanvas } from "../../utils/access";
import { saveSnapshot } from "../../utils/snapshots";
import { fail, json, body, isObject, assertOwner } from "../../utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  const req = apiRequest(event);
  const user = await requireUser(event);

  assertOwner(req, user.id, "x-resource-owner");
  const row = await requireCanvas(id, user);

  const data = await body(req);
  const scene = data.scene;

  if (
    !isObject(scene) ||
    !Array.isArray(scene.elements) ||
    !isObject(scene.appState) ||
    !isObject(scene.files)
  )
    return fail(400, "INVALID_SCENE", "画布数据格式无效");

  return json(
    await saveSnapshot(event, user, "canvas", id, row, data.revision, scene),
  );
});
