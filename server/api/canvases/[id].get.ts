import { defineApiHandler, resourceId } from "#server/utils/api";
import { requireUser } from "#server/utils/auth";
import { requireCanvas } from "#server/utils/access";
import { meta, readSnapshot } from "#server/utils/snapshots";
import { apiRequest } from "#server/utils/request";
import { canvasValidator } from "#shared/snapshotValidator";
import { ApiError, json, assertOwner } from "#server/utils/http";

import {
  canvasCommand,
  hydrateView,
  ensureRoom,
  principal,
} from "#server/collaboration/service";
import type { CanvasView } from "#shared/collaboration/types";

const EMPTY_SCENE = { elements: [], appState: {}, files: {} };

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  const user = await requireUser(event);
  const req = apiRequest(event);

  assertOwner(req, user.id, "x-resource-owner");
  let row = await requireCanvas(id, user);

  if (
    req.headers.get("x-collaboration-protocol") === "1" &&
    row.syncMode !== "collaborative"
  ) {
    await ensureRoom(event, id, await principal(event));
    row = await requireCanvas(id, user);
  }

  if (row.syncMode !== "legacy") {
    const view = await canvasCommand<CanvasView>(event, id, { type: "view" });
    const ETag = `"collaboration:${view.epoch}:${view.seq}:${encodeURIComponent(row.name)}"`;

    if (req.headers.get("if-none-match") === ETag)
      return new Response(null, { status: 304, headers: { ETag } });
    const hydrated = await hydrateView(view);

    return json(
      { canvas: { ...meta(row), revision: view.seq, scene: hydrated.scene } },
      200,
      { ETag },
    );
  }

  const headers = {
    ETag: canvasValidator(row),
    "Cache-Control": "no-store",
  };

  if (req.headers.get("if-none-match") === headers.ETag)
    return new Response(null, { status: 304, headers });

  try {
    return json(
      {
        canvas: {
          ...meta(row),
          scene: await readSnapshot(row.objectKey, EMPTY_SCENE),
        },
      },
      200,
      headers,
    );
  } catch (error) {
    // An autosave may have replaced and removed this immutable object after the D1 read.
    if (!(error instanceof ApiError) || error.code !== "STORAGE_UNAVAILABLE")
      throw error;
    const latest = await requireCanvas(id, user);

    return json(
      {
        canvas: {
          ...meta(latest),
          scene: await readSnapshot(latest.objectKey, EMPTY_SCENE),
        },
      },
      200,
      {
        ETag: canvasValidator(latest),
      },
    );
  }
});
