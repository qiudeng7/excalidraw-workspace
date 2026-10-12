import { blob } from "@nuxthub/blob";
import { defineApiHandler, resourceId } from "../../../../utils/api";
import { body, json, fail, ApiError } from "../../../../utils/http";
import { apiRequest } from "../../../../utils/request";
import {
  canvasCommand,
  projectMember,
} from "../../../../collaboration/service";
import {
  importRoom,
  type RoomBackup,
} from "../../../../../shared/collaboration/backup";
import { referencedRoomObjects } from "../../../../collaboration/garbage-collection";
import {
  canonical,
  CollaborationError,
  validateElement,
} from "../../../../../shared/collaboration/merge";
import type { SharedScene } from "../../../../../shared/collaboration/types";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);
  const current = await canvasCommand<RoomBackup>(event, id, {
    type: "backup",
  });
  const data = await body(apiRequest(event), 48 * 1024 * 1024);
  const backup = data.backup as RoomBackup;
  const epoch = crypto.randomUUID();
  let restored;

  try {
    restored = importRoom(current.state, backup, epoch);
  } catch (error) {
    if (error instanceof CollaborationError)
      return fail(error.status, error.code, error.message);
    throw error;
  }

  // Validate every immutable object before changing authority. A failed restore
  // leaves the live room intact; uploaded objects are collected after the grace period.
  for (const key of referencedRoomObjects(restored)) {
    const object = await blob.get(key);

    if (!object)
      return fail(400, "BACKUP_OBJECT_MISSING", "请先上传备份引用的全部对象");
    const value = JSON.parse(await object.text());
    const version = restored.versions.find((item) => item.sceneKey === key);

    if (version) {
      const scene = value as SharedScene;

      if (
        !Array.isArray(scene.elements) ||
        canonical(scene.files) !== canonical(version.files)
      )
        return fail(400, "INVALID_BACKUP_OBJECT", "固定版本图片清单不匹配");
      for (const element of scene.elements) {
        try {
          validateElement(element);
        } catch (error) {
          throw new ApiError(400, "INVALID_BACKUP_OBJECT", "固定版本元素无效", {
            cause: error,
          });
        }
      }
    } else if (
      typeof value.dataURL !== "string" ||
      !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(
        value.dataURL,
      ) ||
      value.dataURL.length > 10 * 1024 * 1024
    )
      return fail(400, "INVALID_BACKUP_OBJECT", "备份图片无效");
  }

  const result = await canvasCommand(event, id, {
    type: "restore",
    backup,
    epoch,
    expectedEpoch: String(data.expectedEpoch),
    expectedSeq: Number(data.expectedSeq),
    expectedAccessRevision: Number(data.expectedAccessRevision),
  });

  await projectMember(event, id);

  return json(result);
});
