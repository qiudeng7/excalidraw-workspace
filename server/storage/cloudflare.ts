import { createStorage } from "unstorage";
import { objectStore, type SnapshotStorage } from "./objects";
import { workspaceR2Driver } from "./r2";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { Repository, type SqlDriver, type Statement } from "./repository";

export interface CloudflareBindings {
  DB: D1Database;
  DATA: R2Bucket;
  PUBLIC_ORIGIN?: string;
}

export function cloudflareStorage(
  env: CloudflareBindings,
  storage?: SnapshotStorage,
) {
  return {
    repository: cloudflareRepository(env.DB),
    objects: cloudflareObjects(env.DATA, storage),
  };
}

export function cloudflareRepository(database: D1Database) {
  const statement = (item: Statement) =>
    database.prepare(item.sql).bind(...item.values);

  const driver: SqlDriver = {
    async query(sql, values = []) {
      const result = await database
        .prepare(sql)
        .bind(...values)
        .all();

      return { rows: result.results, changes: result.meta.changes };
    },

    async transaction(items) {
      const results = await database.batch<Record<string, unknown>>(
        items.map(statement),
      );

      return results.map((result) => ({
        rows: result.results,
        changes: result.meta.changes,
      }));
    },
  };

  return new Repository(driver);
}

export function cloudflareObjects(bucket: R2Bucket, storage?: SnapshotStorage) {
  return objectStore(
    storage ?? createStorage({ driver: workspaceR2Driver(bucket) }),
    async (cursor) => {
      // R2's page already includes upload times: do not spend one Worker subrequest per object.
      const page = await bucket.list({ cursor, limit: 1000 });

      return {
        objects: page.objects.map((object) => ({
          key: object.key,
          modified: object.uploaded.getTime(),
        })),
        cursor: page.truncated ? page.cursor : undefined,
      };
    },
    async (keys) => {
      // Preserve R2 bulk deletion instead of spending a subrequest on every key.
      for (let offset = 0; offset < keys.length; offset += 1000)
        await bucket.delete(keys.slice(offset, offset + 1000));
    },
  );
}
