import { defineConfig } from "@playwright/test";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../../", import.meta.url));

// A fresh port and server belong to this run; never reuse a developer's service.
const externalURL = process.env.BROWSER_BASE_URL;
const portServer = createServer();

await new Promise<void>((resolve) =>
  portServer.listen(0, "127.0.0.1", resolve),
);
const address = portServer.address();

if (!address || typeof address === "string") throw new Error("No test port");
// Playwright loads config again in child processes; carry the chosen port to them.
const port = Number(process.env.WORKSPACE_BROWSER_PORT || address.port);

process.env.WORKSPACE_BROWSER_PORT = String(port);
const baseURL = externalURL || `http://127.0.0.1:${port}`;

await new Promise<void>((resolve, reject) =>
  portServer.close((error) => (error ? reject(error) : resolve())),
);

export default defineConfig({
  testDir: fileURLToPath(new URL("./", import.meta.url)),
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 8000 },
  outputDir: join(project, "test-results/browser"),
  reporter: "list",
  use: {
    baseURL,
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      ...(process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH }
        : {}),
      args: ["--no-proxy-server"],
    },
  },
  ...(externalURL
    ? {}
    : {
        webServer: {
          command: `pnpm build:editor && exec node tests/browser/server.mjs ${port}`,
          cwd: project,
          url: baseURL,
          reuseExistingServer: false,
          gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
          timeout: 180000,
          env: { NUXT_TELEMETRY_DISABLED: "1" },
        },
      }),
});
