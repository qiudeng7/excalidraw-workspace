import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
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
) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(dataDir, "workspace.sqlite"));
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
    db.close();
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
  const root = resolve(dataDir, "objects");
  await mkdir(root, { recursive: true, mode: 0o700 });
  function objectPath(key: string) {
    if (!/^[a-zA-Z0-9/-]+\.json$/.test(key) || key.includes(".."))
      throw new Error("Invalid private object key");
    const path = resolve(root, key);
    if (relative(root, path).startsWith(".."))
      throw new Error("Invalid object path");
    return path;
  }
  const objects: ObjectStore = {
    async read(key) {
      try {
        return JSON.parse(await readFile(objectPath(key), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(key, value) {
      const path = objectPath(key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(value), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
    },
    async delete(keys) {
      await Promise.all(
        keys.map((key) => rm(objectPath(key), { force: true })),
      );
    },
    async list() {
      const entries = await readdir(root, {
        recursive: true,
        withFileTypes: true,
      });
      const result: {
        key: string;
        modified: number;
      }[] = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const path = resolve(entry.parentPath, entry.name);
        const key = relative(root, path).replaceAll("\\", "/");
        const modified = (await stat(path)).mtimeMs;
        if (entry.name.endsWith(".tmp")) {
          if (modified < Date.now() - 24 * 60 * 60 * 1000)
            await rm(path, { force: true });
          continue;
        }
        if (entry.name.endsWith(".json")) result.push({ key, modified });
      }
      return { objects: result };
    },
  };
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
    close() {
      clearInterval(timer);
      db.close();
    },
  };
}
