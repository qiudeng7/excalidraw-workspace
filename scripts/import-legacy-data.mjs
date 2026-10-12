#!/usr/bin/env node
import { DatabaseSync, backup } from "node:sqlite";
import { access, cp, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/** Copy an offline legacy installation; never modify the source or merge destinations. */
export async function importLegacyData(source, target) {
  source = resolve(source);
  target = resolve(target);
  if (source === target || target.startsWith(source + sep))
    throw new Error("Destination must be outside the source directory");
  if (
    await stat(target).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  )
    throw new Error("Destination already exists; choose a new empty location");

  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(
    resolve(dirname(target), `.${basename(target)}-import-`),
  );
  let sourceDb;

  try {
    sourceDb = new DatabaseSync(resolve(source, "workspace.sqlite"), {
      readOnly: true,
    });
    await mkdir(resolve(staging, "db"), { mode: 0o700 });
    const databasePath = resolve(staging, "db/sqlite.db");
    await backup(sourceDb, databasePath);
    const db = new DatabaseSync(databasePath);

    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec(
        "CREATE TABLE IF NOT EXISTS _hub_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
      );
      const legacy = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
        )
        .get();
      if (legacy) {
        db.exec(
          "INSERT OR IGNORE INTO _hub_migrations(name) SELECT substr(name,1,length(name)-4) FROM schema_migrations WHERE name LIKE '%.sql'",
        );
        db.exec("DROP TABLE schema_migrations");
      }
      if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
        throw new Error("Source database failed integrity check");
      if (db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("Source database contains broken foreign keys");
      db.exec("COMMIT");

      const blobs = resolve(staging, "blob");
      await mkdir(blobs, { mode: 0o700 });
      const keys = db
        .prepare(
          "SELECT object_key FROM canvases WHERE object_key IS NOT NULL UNION SELECT object_key FROM libraries WHERE object_key IS NOT NULL",
        )
        .all();
      const objectsExist = await stat(resolve(source, "objects")).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (objectsExist)
        await cp(resolve(source, "objects"), blobs, { recursive: true });
      for (const { object_key: key } of keys) {
        const path = resolve(blobs, key);
        if (!path.startsWith(blobs + sep))
          throw new Error("Invalid stored object path");
        await access(path);
      }
      await rename(staging, target);

      return { referencedObjects: keys.length };
    } finally {
      db.close();
    }
  } finally {
    sourceDb?.close();
    await rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.umask(0o077);
  const { values } = parseArgs({
    options: { source: { type: "string" }, target: { type: "string" } },
  });
  try {
    if (!values.source || !values.target)
      throw new Error(
        "Usage: node scripts/import-legacy-data.mjs --source OLD_DATA --target NEW_DATA",
      );
    const result = await importLegacyData(values.source, values.target);
    console.log(
      `Imported ${result.referencedObjects} referenced snapshots. Source unchanged.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Import failed");
    process.exitCode = 1;
  }
}
