import { defineApiHandler, resourceId } from "../../../../utils/api";
import { body, json, name, fail } from "../../../../utils/http";
import { apiRequest } from "../../../../utils/request";
import { canvasCommand } from "../../../../collaboration/service";

import { blob } from "@nuxthub/blob";
import type {
  CanvasView,
  PublishedVersion,
} from "../../../../../shared/collaboration/types";

export default defineApiHandler(async (event) => {
  const data = await body(apiRequest(event));

  if (typeof data.id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(data.id))
    return fail(400, "INVALID_VERSION", "版本标识无效");

  const id = resourceId(event);
  const manage = await canvasCommand<{ versions: PublishedVersion[] }>(
    event,
    id,
    { type: "manage" },
  );
  const prior = manage.versions.find((version) => version.id === data.id);

  if (prior) return json({ id: prior.id, seq: prior.seq });
  const view = await canvasCommand<CanvasView>(event, id, { type: "view" });
  const sceneKey = `collaboration/${id}/versions/${crypto.randomUUID()}.json`;

  await blob.put(sceneKey, JSON.stringify(view.scene), {
    contentType: "application/json",
  });

  return json(
    await canvasCommand(event, id, {
      type: "publish",
      id: data.id,
      label: name(data.label),
      snapshot: {
        sceneKey,
        epoch: view.epoch,
        seq: view.seq,
        name: view.name,
        files: view.scene.files,
      },
    }),
  );
});
