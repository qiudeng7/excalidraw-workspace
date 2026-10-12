#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { localOrigin } from "./support/local-client.mjs";

const children = new Map();
const project = fileURLToPath(new URL("../../", import.meta.url));
let stopping = false;

function launch(args) {
  if (stopping) throw new Error("Test run is stopping");
  const child = spawn("pnpm", args, {
    cwd: project,
    detached: true,
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const exited = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  children.set(child, exited);
  exited.then(() => children.delete(child));

  return { child, exited };
}

async function command(args) {
  const { exited } = launch(args);
  const result = await exited;

  if (result.error) throw result.error;
  if (result.code !== 0)
    throw new Error(`pnpm ${args.join(" ")}: ${result.signal ?? result.code}`);
}

async function availablePort() {
  const server = createServer();

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  return port;
}

let directory;
let worker;
let cleanupPromise;

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function cleanup() {
  return (cleanupPromise ??= (async () => {
    stopping = true;
    const active = [...children];

    for (const [child] of active) if (child.pid) killGroup(child, "SIGTERM");
    for (const [child, exited] of active) {
      let timer;
      const finished = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 5000);
        }),
      ]);

      clearTimeout(timer);
      if (!finished && child.pid) {
        killGroup(child, "SIGKILL");
        await exited;
      }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  })());
}

// Ctrl-C/termination still releases the isolated Worker and its data.
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });

try {
  let origin = process.argv[2];

  if (origin) {
    origin = localOrigin(origin).origin;
  } else {
    await command(["build"]);
    directory = await mkdtemp(join(tmpdir(), "excalidraw-worker-test-"));
    await command([
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--persist-to",
      directory,
    ]);
    const port = await availablePort();

    origin = `http://127.0.0.1:${port}`;
    ({ child: worker } = launch([
      "exec",
      "wrangler",
      "dev",
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
    const deadline = Date.now() + 60000;

    while (true) {
      if (worker.exitCode !== null || worker.signalCode !== null)
        throw new Error("Worker exited before readiness");
      try {
        const response = await fetch(`${origin}/api/bootstrap`, {
          signal: AbortSignal.timeout(1000),
        });

        if (response.ok && (await response.json()).needsSetup === true) break;
      } catch (error) {
        if (Date.now() >= deadline)
          throw new Error("Worker readiness timed out", { cause: error });
      }
      if (Date.now() >= deadline) throw new Error("Worker readiness timed out");
      // Readiness polling, not a guessed startup delay.
      await delay(100);
    }
  }
  await command(["exec", "node", "tests/http/user-settings.mjs", origin]);
  await command([
    "exec",
    "node",
    "tests/http/account-compatibility.mjs",
    origin,
  ]);
  await command(["exec", "node", "tests/http/cache.mjs", origin]);
} finally {
  await cleanup();
}
