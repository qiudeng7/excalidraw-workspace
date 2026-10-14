#!/usr/bin/env node
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  availablePort,
  cleanup,
  command,
  launch,
  project,
  temporaryDirectory,
} from "./support/runtime.mjs";

const runtime = process.argv[2] ?? "worker";

if (!["worker", "node"].includes(runtime))
  throw new Error("Usage: node tests/http/run-development.mjs [worker|node]");
const directory = await temporaryDirectory(
  `excalidraw-development-${runtime}-`,
);
const port = await availablePort();
const origin = `http://localhost:${port}`;
const environment = {
  DEV_ADMIN_EMAIL: "dev-admin@local.test",
  DEV_ADMIN_PASSWORD: "Dev-admin-original-2026!",
  DEV_USER_EMAIL: "dev-user@local.test",
  DEV_USER_PASSWORD: "Dev-user-original-2026!",
};
let server;

async function request(path, method = "GET", data, cookie) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      Origin: origin,
      "X-Requested-With": "excalidraw-demo",
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });

  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}

async function start(env = environment) {
  server = launch(
    [
      join(project, "scripts/dev.mjs"),
      "--runtime",
      runtime,
      "--port",
      String(port),
      "--data-dir",
      directory,
    ],
    { executable: process.execPath, env, stdio: ["ignore", "pipe", "inherit"] },
  );
  let output = "";
  const ready = new Promise((resolve, reject) => {
    server.child.stdout.on("data", (data) => {
      process.stdout.write(data);
      output = (output + data).slice(-10000);
      if (output.includes("开发服务器已就绪")) resolve();
    });
    server.exited.then(() =>
      reject(new Error("Unified devserver exited before readiness")),
    );
  });
  let timer;

  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Unified devserver readiness timed out")),
          240000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stop() {
  if (!server) return;
  process.kill(-server.child.pid, "SIGTERM");
  let timer;

  try {
    await Promise.race([
      server.exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Unified devserver cleanup timed out")),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  server = undefined;
}

try {
  await start();
  const bootstrap = await request("/bootstrap");

  assert.equal(bootstrap.body.needsSetup, false);
  assert.equal(
    bootstrap.body.developmentAccounts[0].email,
    environment.DEV_ADMIN_EMAIL,
  );
  assert.equal(
    bootstrap.body.developmentAccounts[0].password,
    environment.DEV_ADMIN_PASSWORD,
  );
  assert.equal((await request("/session")).body.user, null);
  const credentials = {
    email: environment.DEV_ADMIN_EMAIL,
    password: environment.DEV_ADMIN_PASSWORD,
  };
  const login = await request("/login", "POST", credentials);

  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, "admin");
  const workspaces = (
    await request("/workspaces", "GET", undefined, login.cookie)
  ).body.workspaces;
  const canvas = (
    await request(
      `/workspaces/${workspaces[0].id}/canvases`,
      "GET",
      undefined,
      login.cookie,
    )
  ).body.canvases[0];

  assert.equal(
    (
      await request(
        `/canvases/${canvas.id}`,
        "PATCH",
        { name: "保留开发数据" },
        login.cookie,
      )
    ).status,
    200,
  );
  await command(
    [
      "exec",
      "playwright",
      "test",
      "--config",
      "tests/browser/playwright.config.ts",
      "development-login.spec.ts",
    ],
    { env: { BROWSER_BASE_URL: origin, DEVELOPMENT_LIVE_TEST: "1" } },
  );
  await stop();
  await start();
  assert.equal(
    (await request("/session", "GET", undefined, login.cookie)).body.user.id,
    login.body.user.id,
    "unchanged seed must preserve sessions",
  );
  assert.equal(
    (await request(`/canvases/${canvas.id}`, "GET", undefined, login.cookie))
      .body.canvas.name,
    "保留开发数据",
  );
  await stop();
  const updated = {
    ...environment,
    DEV_ADMIN_PASSWORD: "Dev-admin-updated-2026!",
  };

  await start(updated);
  assert.equal((await request("/login", "POST", credentials)).status, 401);
  assert.equal(
    (await request("/session", "GET", undefined, login.cookie)).body.user,
    null,
  );
  const next = await request("/login", "POST", {
    ...credentials,
    password: updated.DEV_ADMIN_PASSWORD,
  });

  assert.equal(next.status, 200);
  assert.equal(next.body.user.id, login.body.user.id);
  assert.equal(
    (await request("/bootstrap")).body.developmentAccounts[0].password,
    updated.DEV_ADMIN_PASSWORD,
  );
  assert.equal(
    (await request(`/canvases/${canvas.id}`, "GET", undefined, next.cookie))
      .body.canvas.name,
    "保留开发数据",
  );
  assert.equal(
    (
      await request("/login", "POST", {
        email: environment.DEV_USER_EMAIL,
        password: environment.DEV_USER_PASSWORD,
      })
    ).body.user.role,
    "user",
  );
  await stop();

  if (runtime === "worker") {
    // Reuse the ordinary build without the launcher's runtime opt-in.
    const emptyEnvironment = join(directory, ".empty.env");

    await writeFile(emptyEnvironment, "");
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
      emptyEnvironment,
      "--var",
      `PUBLIC_ORIGIN:${origin}`,
    ]);
    const deadline = Date.now() + 60000;
    let normal;

    while (Date.now() < deadline) {
      try {
        normal = await request("/bootstrap");
        if (normal.status === 200) break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      await delay(100);
    }
    assert.equal(normal?.status, 200);
    assert.equal(normal.body.developmentAccounts, undefined);
    assert.equal((await request("/development/prepare", "POST")).status, 404);
  }
  console.log(
    `Unified ${runtime} development: prefill, login, restart persistence, credential synchronization and isolation passed`,
  );
} finally {
  await stop();
  await cleanup();
}
