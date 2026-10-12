import { AsyncLocalStorage } from "node:async_hooks";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../../server/db/schema";

export type TestDatabase = LibSQLDatabase<typeof schema>;

const databases = new AsyncLocalStorage<() => TestDatabase>();

export const db = new Proxy({} as TestDatabase, {
  get(_target, key) {
    const database = databases.getStore()?.();

    if (!database) throw new Error("Missing test database");
    const value = Reflect.get(database, key);

    return typeof value === "function" ? value.bind(database) : value;
  },
});

export function withDatabase<T>(
  database: TestDatabase | (() => TestDatabase),
  run: () => T,
): T {
  return databases.run(
    typeof database === "function" ? database : () => database,
    run,
  );
}
