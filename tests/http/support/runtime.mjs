#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const children = new Map();
const project = fileURLToPath(new URL("../../../", import.meta.url));
let stopping = false;

function launch(args, options = {}) {
  if (stopping) throw new Error("Test run is stopping");
  const { executable = "pnpm", ...spawnOptions } = options;
  const child = spawn(executable, args, {
    cwd: project,
    ...spawnOptions,
    detached: true,
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...options.env },
  });
  const exited = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  children.set(child, exited);
  exited.then(() => children.delete(child));

  return { child, exited };
}

async function command(args, options) {
  const { exited } = launch(args, options);
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

export { project, launch, command, availablePort, cleanup };
export async function temporaryDirectory(prefix) {
  directory = await mkdtemp(join(tmpdir(), prefix));
  return directory;
}
export async function ready(child, origin) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Server exited before readiness");
    try {
      const response = await fetch(`${origin}/api/bootstrap`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok && (await response.json()).needsSetup === true) return;
    } catch (error) {
      if (Date.now() >= deadline)
        throw new Error("Server readiness timed out", { cause: error });
    }
    await delay(100);
  }
  throw new Error("Server readiness timed out");
}
