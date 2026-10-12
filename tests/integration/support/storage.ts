import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { createBlobStorage } from "@nuxthub/core/blob";
import { createDriver } from "@nuxthub/core/blob/drivers/fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResolvedHubConfig } from "@nuxthub/core";
import {
  applyDatabaseMigrations,
  copyDatabaseMigrationsToHubDir,
} from "@nuxthub/core/db";
import { sql } from "drizzle-orm";
import * as schema from "../../../server/db/schema";
import * as accounts from "../../../server/db/accounts";
import * as sessions from "../../../server/db/sessions";
import * as workspaces from "../../../server/db/workspaces";
import * as canvases from "../../../server/db/canvases";
import * as navigation from "../../../server/db/navigation";
import * as snapshots from "../../../server/db/snapshots";
import * as settings from "../../../server/db/user-settings";
import { withBlob } from "../../lib/blobs";
import { collectOrphans } from "../../../server/utils/cleanup";
import { withDatabase } from "../../lib/database";

const operations = {
  ...accounts,
  ...sessions,
  ...workspaces,
  ...canvases,
  ...navigation,
  ...snapshots,
  ...settings,
};

/** Standalone tests use the same Drizzle driver and NuxtHub migration runner as Node. */
export async function nodeStorage(
  directory: string,
  migrationsDir = resolve("server/db/migrations"),
) {
  const client = createClient({
    url: pathToFileURL(resolve(directory, "workspace.sqlite")).href,
  });
  const statements: string[] = [];
  const database = drizzle(client, {
    schema,
    logger: {
      logQuery(query) {
        statements.push(query);
      },
    },
  });
  const hub: ResolvedHubConfig = {
    dir: resolve(directory, "hub"),
    hosting: "node-server",
    blob: false,
    cache: false,
    kv: false,
    db: {
      dialect: "sqlite",
      driver: "libsql",
      connection: {},
      migrationsDirs: [migrationsDir],
      queriesPaths: [],
      applyMigrationsDuringBuild: false,
      applyMigrationsDuringDev: false,
    },
  };

  try {
    await copyDatabaseMigrationsToHubDir(hub);
    await database.run(sql`PRAGMA foreign_keys=ON`);
    if ((await applyDatabaseMigrations(hub, database)) === false)
      throw new Error("Database migration failed");
  } catch (error) {
    client.close();
    throw error;
  }

  const blob = createBlobStorage(
    createDriver({ dir: resolve(directory, "objects") }),
  );
  // Fixture convenience only; production directly uses the NuxtHub Blob SDK.
  const objects = {
    async read(key: string) {
      const value = await blob.get(key);

      return value ? JSON.parse(await value.text()) : null;
    },
    write: (key: string, value: unknown) =>
      blob.put(key, JSON.stringify(value)),
  };
  const queries = Object.fromEntries(
    Object.entries(operations).map(([key, operation]) => [
      key,
      (...args: never[]) =>
        withDatabase(database, () =>
          (operation as (...values: never[]) => unknown)(...args),
        ),
    ]),
  ) as typeof operations;

  return {
    database,
    queries,
    statements,
    objects,
    blob,
    collectOrphans: () =>
      withDatabase(database, () => withBlob(blob, () => collectOrphans())),
    close() {
      client.close();
    },
  };
}
