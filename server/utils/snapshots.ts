import { canvas } from "#server/db/canvases";
import { publishSnapshot } from "#server/db/snapshots";
import type { H3Event } from "h3";
import type { User } from "#shared/contracts";
import { blob } from "@nuxthub/blob";
import { fail, validRevision } from "#server/utils/http";
import { runBackground } from "#server/utils/request";

export function meta<T extends { objectKey: string | null }>(row: T) {
  const { objectKey: _, ...rest } = row;

  return rest;
}

export interface SnapshotMetadata {
  revision: number;
  objectKey: string | null;
}

export async function readSnapshot(key: string | null, fallback: unknown) {
  if (!key) return fallback;
  const object = await blob.get(key);

  if (!object)
    return fail(
      503,
      "STORAGE_UNAVAILABLE",
      "保存的数据暂时无法读取，请稍后重试",
    );
  const value: unknown = JSON.parse(await object.text());

  if (!value || typeof value !== "object")
    throw new Error("Invalid stored snapshot JSON");

  return value;
}

export async function deleteSnapshots(keys: string[]) {
  // Bound the SDK's concurrent deletes when a workspace contains many snapshots.
  for (let offset = 0; offset < keys.length; offset += 100)
    await blob.del(keys.slice(offset, offset + 100));
}

/** Publish an immutable object before committing its metadata revision. */
export async function saveSnapshot(
  event: H3Event,
  user: User,
  type: "canvas" | "library",
  id: string,
  row: SnapshotMetadata,
  revision: unknown,
  value: unknown,
) {
  const expectedRevision = validRevision(revision);

  if (row.revision !== expectedRevision)
    fail(
      409,
      "REVISION_CONFLICT",
      "其他页面已经修改了内容，请重新加载后再编辑",
    );
  const key = `${user.id}/${type}/${id}/${crypto.randomUUID()}.json`;
  const now = new Date().toISOString();

  await blob.put(key, JSON.stringify(value), {
    contentType: "application/json",
  });
  let changes: number;

  try {
    changes = await publishSnapshot(
      type,
      id,
      user.id,
      key,
      expectedRevision,
      now,
    );
  } catch (error) {
    runBackground(event, deleteSnapshots([key]));
    throw error;
  }

  if (!changes) {
    runBackground(event, deleteSnapshots([key]));
    const currentMode =
      type === "canvas" ? (await canvas(id, user.id))?.syncMode : undefined;

    if (currentMode && currentMode !== "legacy")
      fail(409, "COLLAB_PROTOCOL_REQUIRED", "此画布已启用协作，请接续协作编辑");
    fail(409, "REVISION_CONFLICT", "其他页面已经修改或删除了内容，请重新加载");
  }

  if (row.objectKey) runBackground(event, deleteSnapshots([row.objectKey]));

  return { revision: expectedRevision + 1, updatedAt: now };
}
