import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { applyDatabaseMigrations } from "@nuxthub/core/db";

// This entry is bundled into .output/server, alongside NuxtHub's SQL assets.
process.umask(0o077);
const dataDirectory = process.env.WORKSPACE_DEV_DATA_DIR || ".data";
await mkdir(`${dataDirectory}/db`, { recursive: true });
const client = createClient({ url: `file:${dataDirectory}/db/sqlite.db` });

try {
  const result = await applyDatabaseMigrations(
    {
      dir: fileURLToPath(new URL(".", import.meta.url)),
      db: { dialect: "sqlite" },
    },
    drizzle(client),
  );

  if (result === false)
    throw new Error("Database migration failed; server not started");
} finally {
  client.close();
}

// Keep the listening server in this process, after migrations have succeeded.
await import("./index.mjs");
