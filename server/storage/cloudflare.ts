import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  Repository,
  type SqlDriver,
  type ObjectStore,
  type Statement,
} from "./repository";
export interface CloudflareBindings {
  DB: D1Database;
  DATA: R2Bucket;
  PUBLIC_ORIGIN?: string;
}
export function cloudflareStorage(env: CloudflareBindings) {
  const statement = (item: Statement) =>
    env.DB.prepare(item.sql).bind(...item.values);
  const driver: SqlDriver = {
    async query(sql, values = []) {
      const result = await env.DB.prepare(sql)
        .bind(...values)
        .all();
      return { rows: result.results, changes: result.meta.changes };
    },
    async transaction(items) {
      const results = await env.DB.batch<Record<string, unknown>>(
        items.map(statement),
      );
      return results.map((result) => ({
        rows: result.results,
        changes: result.meta.changes,
      }));
    },
  };
  const objects: ObjectStore = {
    async read(key) {
      const object = await env.DATA.get(key);
      return object ? object.json() : null;
    },
    async write(key, value) {
      await env.DATA.put(key, JSON.stringify(value), {
        httpMetadata: { contentType: "application/json" },
      });
    },
    async delete(keys) {
      for (let offset = 0; offset < keys.length; offset += 1000)
        await env.DATA.delete(keys.slice(offset, offset + 1000));
    },
    async list(cursor) {
      const page = await env.DATA.list({ cursor, limit: 1000 });
      return {
        objects: page.objects.map((object) => ({
          key: object.key,
          modified: object.uploaded.getTime(),
        })),
        cursor: page.truncated ? page.cursor : undefined,
      };
    },
  };
  return { repository: new Repository(driver), objects };
}
