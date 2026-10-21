#!/usr/bin/env node
import { localOrigin } from "./support/local-client.mjs";
import {
  command,
  launch,
  availablePort,
  temporaryDirectory,
  ready,
  cleanup,
} from "./support/runtime.mjs";
let directory;
let worker;

try {
  let origin = process.argv[2];

  if (origin) {
    origin = localOrigin(origin).origin;
  } else {
    await command(["build"]);
    directory = await temporaryDirectory("excalidraw-worker-test-");
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
    const port = await availablePort();

    origin = `http://127.0.0.1:${port}`;
    ({ child: worker } = launch([
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
    ]));
    await ready(worker, origin);
  }
  await command(["exec", "node", "tests/http/user-settings.mjs", origin]);
  await command([
    "exec",
    "node",
    "tests/http/account-compatibility.mjs",
    origin,
  ]);
  await command(["exec", "node", "tests/http/cache.mjs", origin]);
  await command(["exec", "node", "tests/http/catalog-pagination.mjs", origin]);
} finally {
  await cleanup();
}
