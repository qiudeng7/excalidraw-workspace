// Playwright owns this Nuxt instance; all local storage belongs to this run.
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toNodeListener } from "h3";
import { loadNuxt, buildNuxt, writeTypes } from "nuxt/kit";

const directory = await mkdtemp(join(tmpdir(), "excalidraw-browser-test-"));
let nuxt;
let server;
let closing;

// Vite also handles termination and may call process.exit before asynchronous
// Nuxt close hooks finish. Synchronously remove only this run's storage then.
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));

function close() {
  return (closing ??= (async () => {
    const stopped = server
      ? new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        })
      : Promise.resolve();

    await Promise.all([stopped, nuxt?.close()]);
    await rm(directory, { recursive: true, force: true });
  })());
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    // All APIs are mocked, so no live account writes need draining. Remove
    // storage before other framework signal handlers can terminate this process.
    rmSync(directory, { recursive: true, force: true });
    const deadline = setTimeout(() => process.exit(0), 5000);

    deadline.unref();
    await close();
    clearTimeout(deadline);
    process.exit(0);
  });

try {
  nuxt = await loadNuxt({
    dev: true,
    overrides: {
      hub: {
        // NuxtHub adds hub.dir to .gitignore in dev mode. Keep generated
        // metadata under the existing generic artifact entry.
        dir: "test-results",
        blob: { driver: "fs", dir: join(directory, "blob") },
        db: { connection: { url: `file:${join(directory, "sqlite.db")}` } },
      },
      devServer: { host: "127.0.0.1", port: Number(process.argv[2]) },
    },
  });
  await writeTypes(nuxt);
  await buildNuxt(nuxt);
  if (!nuxt.server) throw new Error("Nuxt did not create a development server");
  const handler = nuxt.server.handler ?? toNodeListener(nuxt.server.app);

  server = createServer(handler);
  server.on("upgrade", (request, socket, head) =>
    nuxt.server.upgrade?.(request, socket, head),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.argv[2]), "127.0.0.1", resolve);
  });
} catch (error) {
  await close();
  throw error;
}
