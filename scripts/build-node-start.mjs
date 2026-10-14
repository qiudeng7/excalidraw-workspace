import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/node-start.mjs"],
  outfile: ".output/server/start.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Bundle the official migration implementation without its CLI/build exports.
  alias: {
    "@nuxthub/core/db": join(
      dirname(fileURLToPath(import.meta.resolve("@nuxthub/core/db"))),
      "migrations.mjs",
    ),
  },
  external: ["@libsql/client", "drizzle-orm", "drizzle-orm/*", "./index.mjs"],
  define: {
    // Match the database URL captured by nuxt.config.ts during this build.
    "process.env.WORKSPACE_DEV_DATA_DIR": JSON.stringify(
      process.env.WORKSPACE_DEV_DATA_DIR || "",
    ),
  },
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
