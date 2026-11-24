import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createApp, createRouter, defineEventHandler, toWebHandler } from "h3";
import { withDatabase, type TestDatabase } from "../../lib/database";
import "./nitro";
import { withBlob, type TestBlob } from "../../lib/blobs";

export interface ApiFixture {
  database: TestDatabase;
  blob: TestBlob;
  publicOrigin: string;
  /** Extra browser origins allowed by CORS, mirroring the CORS_ORIGINS setting. */
  corsOrigins?: string;
  waitUntil(promise: Promise<unknown>): void;
}

/** Exercise the real file handlers with H3's router; production discovery belongs to Nitro. */
const files = await readdir(new URL("../../../server/api/", import.meta.url), {
  recursive: true,
});
const routes = await Promise.all(
  files
    .filter((file) => file.endsWith(".ts"))
    .map(async (file) => {
      const path = file
        .replace(/\.ts$/, "")
        .replace(/\.(get|post|put|patch|delete)$/, "");
      const method =
        file.match(/\.(get|post|put|patch|delete)\.ts$/)?.[1] || "all";
      const route =
        "/api/" +
        path
          .replace(/\/index$/, "")
          .replace(/\[\.\.\.(\w+)\]/g, "**:$1")
          .replace(/\[(\w+)\]/g, ":$1");
      const module = await import(
        fileURLToPath(new URL(`../../../server/api/${file}`, import.meta.url))
      );

      return { route, method, handler: module.default };
    }),
);

// Load the real Nitro middleware (e.g. CORS) so route behaviour matches production.
const middlewareFiles = await readdir(
  new URL("../../../server/middleware/", import.meta.url),
).catch(() => [] as string[]);
const middlewares = await Promise.all(
  middlewareFiles
    .filter((file) => file.endsWith(".ts"))
    .map(
      async (file) =>
        (
          await import(
            fileURLToPath(
              new URL(`../../../server/middleware/${file}`, import.meta.url),
            )
          )
        ).default,
    ),
);

export async function handleApi(
  request: Request,
  fixture: ApiFixture,
): Promise<Response> {
  const app = createApp();
  const router = createRouter();

  app.use(
    defineEventHandler((event) => {
      event.context.nitro = {
        runtimeConfig: {
          publicOrigin: fixture.publicOrigin,
          trustedProxyIps: "",
          corsOrigins: fixture.corsOrigins ?? "",
        },
      };
      event.waitUntil = fixture.waitUntil;
    }),
  );
  for (const middleware of middlewares) app.use(middleware);
  for (const entry of routes)
    router.add(entry.route, entry.handler, entry.method);
  app.use(router);

  return withDatabase(
    () => fixture.database,
    () => withBlob(fixture.blob, () => toWebHandler(app)(request)),
  );
}
