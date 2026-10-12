import type { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createStorage } from "unstorage";
import fsDriver from "unstorage/drivers/fs-lite";
import { createDatabase, type Database } from "db0";
import nodeSqlite from "db0/connectors/node-sqlite";
import { objectStore, type SnapshotStorage } from "./objects";
import {
  Repository,
  type SqlDriver,
  type ObjectStore,
  collectOrphans,
} from "./repository";

/** Node-only module: loaded dynamically outside the Workers runtime. */
export async function nodeStorage(
  dataDir = process.env.DATA_DIR || resolve(".data"),
  migrationsDir = process.env.MIGRATIONS_DIR || resolve("migrations"),
  native?: {
    database: Pick<Database, "getInstance">;
    storage: SnapshotStorage;
  },
) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const database =
    native?.database ??
    createDatabase(nodeSqlite({ path: resolve(dataDir, "workspace.sqlite") }));
  const db = (await database.getInstance()) as DatabaseSync;

  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)",
  );

  try {
    // A SQLite write lock covers checking and applying migrations, including another process start.
    db.exec("BEGIN IMMEDIATE");
    for (const file of (await readdir(migrationsDir))
      .filter((file) => /^\d.*\.sql$/.test(file))
      .sort()) {
      if (
        db.prepare("SELECT name FROM schema_migrations WHERE name=?").get(file)
      )
        continue;

      db.exec(await readFile(resolve(migrationsDir, file), "utf8"));
      db.prepare("INSERT INTO schema_migrations(name) VALUES(?)").run(file);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (!native) db.close();
    throw error;
  }

  const query = (sql: string, values: unknown[] = []) => {
    const statement = db.prepare(sql);
    const rows = statement.all(
      ...(values as (string | number | null)[]),
    ) as Record<string, unknown>[];
    const changes = (
      db.prepare("SELECT changes() AS count").get() as {
        count: number;
      }
    ).count;

    return { rows, changes };
  };

  const driver: SqlDriver = {
    async query(sql, values) {
      return query(sql, values);
    },

    async transaction(items) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = items.map((item) => query(item.sql, item.values));

        db.exec("COMMIT");

        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };

  const storage =
    native?.storage ?? createStorage({ driver: nodeObjectDriver(dataDir) });
  const objects = objectStore(storage);

  const repository = new Repository(driver);
  const sweep = () =>
    collectOrphans(repository, objects).catch((error) =>
      console.error(
        "Object cleanup failed",
        error instanceof Error ? error.message : "unknown",
      ),
    );

  await sweep();
  const timer = setInterval(sweep, 60 * 60 * 1000);

  timer.unref();

  return {
    repository,
    objects,
    storage,

    close() {
      clearInterval(timer);
      if (!native) db.close();
    },
  };
}

/** Native filesystem driver plus atomic publication of immutable JSON snapshots. */
export function nodeObjectDriver(
  dataDir = process.env.DATA_DIR || resolve(".data"),
) {
  const root = resolve(dataDir, "objects");
  const driver = fsDriver({
    base: root,
    noClear: true,
  });

  return {
    ...driver,
    async getItem(key: string) {
      const result: unknown = await driver.getItem!(key, {});

      if (result instanceof Error) throw result;

      return result;
    },
    async removeItem(key: string) {
      const result: unknown = await driver.removeItem!(key, {});

      if (result instanceof Error) throw result;
    },
    async setItem(key: string, value: string) {
      const path = resolve(root, key.replaceAll(":", "/"));

      if (key.includes("..") || !path.startsWith(`${root}/`))
        throw new Error("Invalid private object key");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${crypto.randomUUID()}.tmp`;

      try {
        await writeFile(temp, value, { mode: 0o600, flag: "wx" });
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
    },
  };
}
