import type { User, SaveResult } from "../../shared/contracts";
import type { ObjectStore, RepositoryPort } from "../storage/repository";
import { fail, validRevision } from "./http";
export function meta<
  T extends {
    objectKey: string | null;
  },
>(row: T) {
  const { objectKey: _, ...rest } = row;
  return rest;
}

export interface SnapshotMetadata {
  revision: number;
  objectKey: string | null;
}
export interface Snapshots {
  read(key: string | null, fallback: unknown): Promise<unknown>;
  delete(keys: string[]): Promise<void>;
  save(
    user: User,
    type: "canvas" | "library",
    id: string,
    row: SnapshotMetadata,
    revision: unknown,
    value: unknown,
  ): Promise<SaveResult>;
}
export interface SnapshotDependencies {
  repository: Pick<RepositoryPort, "saveSnapshot">;
  objects: ObjectStore;
  waitUntil(promise: Promise<unknown>): void;
}
export function createSnapshots({
  repository,
  objects,
  waitUntil,
}: SnapshotDependencies): Snapshots {
  async function readObject(key: string | null, fallback: unknown) {
    if (!key) return fallback;
    const object = await objects.read(key);
    if (!object)
      return fail(
        503,
        "STORAGE_UNAVAILABLE",
        "保存的数据暂时无法读取，请稍后重试",
      );
    return object;
  }
  async function deleteObjects(keys: string[]) {
    // Keep each R2 bulk deletion within its per-request limit.
    for (let offset = 0; offset < keys.length; offset += 1000)
      await objects.delete(keys.slice(offset, offset + 1000));
  }
  async function saveSnapshot(
    user: User,
    type: "canvas" | "library",
    id: string,
    row: SnapshotMetadata,
    revision: unknown,
    value: unknown,
  ) {
    const expectedRevision = validRevision(revision);
    if (row.revision !== expectedRevision)
      return fail(
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
      waitUntil(objects.delete([key]));
      throw error;
    }
    if (!changes) {
      waitUntil(objects.delete([key]));
      return fail(
        409,
        "REVISION_CONFLICT",
        "其他页面已经修改或删除了内容，请重新加载",
      );
    }
    // Immutable keys make the metadata revision switch authoritative.
    if (row.objectKey) waitUntil(objects.delete([row.objectKey]));
    return { revision: expectedRevision + 1, updatedAt: now };
  }
  return { read: readObject, delete: deleteObjects, save: saveSnapshot };
}
