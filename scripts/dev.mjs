#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { developmentAccounts } from "./dev/accounts.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    runtime: { type: "string", default: "worker" },
    port: { type: "string" },
    "data-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(
    "pnpm dev [--runtime worker|node] [--port 8787] [--data-dir directory]",
  );
  process.exit(0);
}
if (!["worker", "node"].includes(values.runtime))
  throw new Error("--runtime 必须是 worker 或 node");
const port = Number(values.port ?? (values.runtime === "worker" ? 8787 : 3000));

if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("--port 必须是 1–65535 的整数");
const directory = resolve(
  project,
  values["data-dir"] ?? `.data/development/${values.runtime}`,
);
const origin = `http://localhost:${port}`;
const accounts = await developmentAccounts(
  join(project, ".env.development.local"),
);
const children = new Set();
let temporary;
let stopping = false;
let cleaning;

function launch(args, env = {}) {
  if (stopping) throw new Error("开发服务器正在退出");
  // Do not bake runtime credentials into Nuxt or editor build artifacts.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("DEV_") &&
        !key.startsWith("WORKSPACE_DEV") &&
        key !== "NITRO_PRESET",
    ),
  );
  const child = spawn("pnpm", args, {
    cwd: project,
    detached: true,
    stdio: "inherit",
    env: {
      ...environment,
      NUXT_TELEMETRY_DISABLED: "1",
      WRANGLER_SEND_METRICS: "false",
      ...env,
    },
  });
  const exited = new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ error }));
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

  children.add(child);
  exited.then(() => {
    // pnpm can exit before the server descendants in its process group.
    if (!groupExists(child)) children.delete(child);
  });

  return { child, exited };
}

async function command(args, env) {
  const result = await launch(args, env).exited;

  if (result.error) throw result.error;
  if (result.code !== 0)
    throw new Error(`开发准备失败 (${result.signal ?? result.code})`);
}

function stop(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function groupExists(child) {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, 0);

    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;

    return false;
  }
}

function cleanup() {
  return (cleaning ??= (async () => {
    stopping = true;
    const active = [...children];

    for (const child of active) if (child.pid) stop(child, "SIGTERM");
    const deadline = Date.now() + 5000;

    while (active.some(groupExists) && Date.now() < deadline) await delay(100);
    for (const child of active) if (groupExists(child)) stop(child, "SIGKILL");
    if (temporary) await rm(temporary, { recursive: true, force: true });
  })());
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });

try {
  // Fail before an expensive build, without disturbing a server on this port.
  const probe = createServer();

  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolveListen);
  });
  await new Promise((resolveClose) => probe.close(resolveClose));
  await mkdir(directory, { recursive: true });
  console.log(`开发环境：${values.runtime}，数据目录：${directory}`);
  const runtime = {
    WORKSPACE_DEVSERVER: "1",
    WORKSPACE_DEVELOPMENT_ACCOUNTS: JSON.stringify(accounts),
    WORKSPACE_DEV_DATA_DIR: directory,
    PUBLIC_ORIGIN: origin,
  };
  let server;

  if (values.runtime === "worker") {
    await command(["build"]);
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
    temporary = await mkdtemp(join(tmpdir(), "excalidraw-devserver-"));
    const environmentFile = join(temporary, ".env");

    await writeFile(
      environmentFile,
      `WORKSPACE_DEVSERVER=1\nWORKSPACE_DEVELOPMENT_ACCOUNTS_BASE64=${Buffer.from(JSON.stringify(accounts)).toString("base64")}\n`,
      { mode: 0o600 },
    );
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
      "--env-file",
      environmentFile,
      "--var",
      `PUBLIC_ORIGIN:${origin}`,
      "--log-level",
      "warn",
    ]);
  } else {
    await mkdir(join(directory, "db"), { recursive: true });
    await command(["build:editor"]);
    await command(["db:migrate"], { WORKSPACE_DEV_DATA_DIR: directory });
    server = launch(
      ["exec", "nuxt", "dev", "--host", "127.0.0.1", "--port", String(port)],
      runtime,
    );
  }

  const deadline = Date.now() + 120000;
  let initialized = false;

  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null)
      throw new Error("开发服务器在就绪前退出");
    let response;

    try {
      response = await fetch(`${origin}/api/bootstrap`, {
        signal: AbortSignal.timeout(1000),
      });
    } catch (error) {
      if (Date.now() >= deadline)
        throw new Error("开发服务器启动超时", { cause: error });
    }
    if (response?.headers.get("content-type")?.includes("application/json")) {
      const body = await response.json();

      if (!response.ok)
        throw new Error(body.error?.message ?? "开发账号初始化失败");
      if (!body.developmentAccounts)
        throw new Error("开发预设未启用，启动已停止");
      const prepared = await fetch(`${origin}/api/development/prepare`, {
        method: "POST",
        headers: { Origin: origin, "X-Requested-With": "excalidraw-demo" },
        signal: AbortSignal.timeout(30000),
      });

      if (!prepared.ok) {
        const failure = await prepared.json();

        throw new Error(failure.error?.message ?? "开发账号初始化失败");
      }
      initialized = true;
      break;
    }
    await delay(100);
  }
  if (!initialized) throw new Error("开发服务器启动超时");
  console.log(
    `开发服务器已就绪：${origin}（登录页已填入管理员账号，可切换普通用户）`,
  );
  const result = await server.exited;

  if (result.error) throw result.error;
  process.exitCode = result.code ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "开发服务器启动失败");
  process.exitCode = 1;
} finally {
  await cleanup();
}
