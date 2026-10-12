import type { H3Event } from "h3";
import type { User } from "../../shared/contracts";
import type { ObjectStore } from "../storage/ports";
import { objectStore } from "../storage/objects";
import {
  cloudflareObjects,
  type CloudflareBindings,
} from "../storage/cloudflare";
import { fail, validRevision } from "./http";
import { runBackground } from "./request";

export function meta<T extends { objectKey: string | null }>(row: T) {
  const { objectKey: _, ...rest } = row;

  return rest;
}

export interface SnapshotMetadata {
  revision: number;
  objectKey: string | null;
}

/** Adapt native storage only where immutable snapshot rules need it. */
export function snapshotObjects(event: H3Event): ObjectStore {
  const storage = useStorage("objects");
  const cf = event.context.cloudflare as
    { env: CloudflareBindings } | undefined;

  return cf ? cloudflareObjects(cf.env.DATA, storage) : objectStore(storage);
}

export async function readSnapshot(
  objects: ObjectStore,
  key: string | null,
  fallback: unknown,
) {
  if (!key) return fallback;
  const object = await objects.read(key);

  if (!object)
    fail(503, "STORAGE_UNAVAILABLE", "保存的数据暂时无法读取，请稍后重试");

  return object;
}

export async function deleteSnapshots(objects: ObjectStore, keys: string[]) {
  for (let offset = 0; offset < keys.length; offset += 1000)
    await objects.delete(keys.slice(offset, offset + 1000));
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
  const repository = await event.context.repository();
  const objects = snapshotObjects(event);
  const expectedRevision = validRevision(revision);

  if (row.revision !== expectedRevision)
    fail(
      409,
      "REVISION_CONFLICT",
      "其他页面已经修改了内容，请重新加载后再编辑",
    );
  const key = `${user.id}/${type}/${id}/${crypto.randomUUID()}.json`;
  const now = new Date().toISOString();

  await objects.write(key, value);
  let changes: number;

  try {
    changes = await repository.saveSnapshot(
      type,
      id,
      user.id,
      key,
      expectedRevision,
      now,
    );
  } catch (error) {
    runBackground(event, objects.delete([key]));
    throw error;
  }

  if (!changes) {
    runBackground(event, objects.delete([key]));
    fail(409, "REVISION_CONFLICT", "其他页面已经修改或删除了内容，请重新加载");
  }

  if (row.objectKey) runBackground(event, objects.delete([row.objectKey]));

  return { revision: expectedRevision + 1, updatedAt: now };
}
