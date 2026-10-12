#!/usr/bin/env node
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import {
  command,
  launch,
  project,
  availablePort,
  temporaryDirectory,
  ready,
  cleanup,
} from "./support/runtime.mjs";

const target = process.argv[2] ?? "worker";

if (!["node", "worker"].includes(target))
  throw new Error("Usage: node tests/http/run-collaboration.mjs [worker|node]");

try {
  await command([target === "worker" ? "build" : "build:node"]);
  const directory = await temporaryDirectory(
    `excalidraw-collaboration-${target}-`,
  );
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let server;

  if (target === "worker") {
    await command([
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      "wrangler.jsonc",
      "--persist-to",
      directory,
    ]);
    server = launch([
      "exec",
      "wrangler",
      "dev",
      "--config",
      "wrangler.jsonc",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--persist-to",
      directory,
      "--var",
      `PUBLIC_ORIGIN:${origin}`,
    ]);
  } else {
    const databaseDirectory = join(directory, ".data/db");

    await mkdir(databaseDirectory, { recursive: true });
    const client = createClient({
      url: pathToFileURL(join(databaseDirectory, "sqlite.db")).href,
    });

    try {
      const migrations = join(project, "server/db/migrations/sqlite");

      for (const filename of (await readdir(migrations))
        .filter((name) => name.endsWith(".sql"))
        .sort())
        await client.executeMultiple(
          await readFile(join(migrations, filename), "utf8"),
        );
    } finally {
      client.close();
    }

    server = launch([join(project, ".output/server/index.mjs")], {
      executable: process.execPath,
      cwd: directory,
      env: {
        PUBLIC_ORIGIN: origin,
        NITRO_HOST: "127.0.0.1",
        NITRO_PORT: String(port),
      },
    });
  }

  await ready(server.child, origin);
  await command(["exec", "node", "tests/http/room-backup.mjs", origin]);
  await command(
    [
      "exec",
      "playwright",
      "test",
      "--config",
      "tests/browser/playwright.config.ts",
      "collaboration.spec.ts",
      ...process.argv.slice(3),
    ],
    {
      env: { BROWSER_BASE_URL: origin, COLLABORATION_LIVE_TEST: "1" },
    },
  );
} finally {
  await cleanup();
}
