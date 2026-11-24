import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeLicenseNotices } from "./scripts/licenses.mjs";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
// Public URL prefix when served behind a reverse proxy or federated host; "" keeps current behavior.
const workspaceBase = (process.env.WORKSPACE_BASE ?? "").replace(/\/+$/, "");
const federationEnabled = process.env.MF_ENABLED === "true";
const appVersion = (
  JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

export default defineNuxtConfig({
  hooks: {
    async "nitro:config"(config) {
      const directory = fileURLToPath(
        new URL("./.nuxt/licenses", import.meta.url),
      );

      await writeLicenseNotices(projectRoot, directory);
      config.publicAssets ||= [];
      config.publicAssets.push({ dir: directory, baseURL: "/", maxAge: 0 });
    },
  },
  compatibilityDate: "2026-09-27",
  vite: {
    define: { __APP_VERSION__: JSON.stringify(appVersion) },
    plugins: federationEnabled
      ? [
          {
            // Nuxt externalizes the shared dir in the SSR build for Nitro to bundle. Federation's
            // server-graph publisher rewrites it into a non-portable build-machine path
            // ("shared//x") and aborts even with moduleFederation.ssr=false; bundle it in Vite.
            name: "workspace:bundle-shared-for-federation",
            configEnvironment(
              name: string,
              environment: {
                build?: { rolldownOptions?: { external?: unknown } };
              },
            ) {
              if (name !== "ssr") return;
              const options = environment.build?.rolldownOptions;

              if (Array.isArray(options?.external))
                options.external = options.external.filter(
                  (item: unknown) =>
                    item !== "#shared" &&
                    !(
                      item instanceof RegExp &&
                      item.test(`${projectRoot}shared/x`)
                    ),
                );
            },
          },
        ]
      : [],
  },
  srcDir: "src/",
  serverDir: "server/",
  modules: [
    "@pinia/nuxt",
    "@nuxthub/core",
    ...(federationEnabled ? ["@module-federation/nuxt"] : []),
  ],
  ...(federationEnabled
    ? {
        moduleFederation: {
          // Browser-only remote: server exposes would need a writable SSR cache.
          ssr: false,
          // Expose names are mapped explicitly: the L2 names equal in-app component names, which
          // the module's auto-scanned directory would register globally and make ambiguous.
          exposedDir: "~/components/.mf-auto-exposed",
          ...(workspaceBase ? { base: workspaceBase } : {}),
          config: {
            name: process.env.MF_NAME || "excalidraw-workspace",
            exposes: {
              "./WorkspaceApp": "./src/components/exposed/WorkspaceApp.vue",
              "./WorkspaceSidebar":
                "./src/components/exposed/WorkspaceSidebar.vue",
              "./CanvasStage": "./src/components/exposed/CanvasStage.vue",
              "./CanvasTabs": "./src/components/exposed/CanvasTabs.vue",
              "./SettingsPanel": "./src/components/exposed/SettingsPanel.vue",
              "./AccountGate": "./src/components/exposed/AccountGate.vue",
              "./client": "./src/lib/client/index.ts",
            },
            ...(workspaceBase ? { publicPath: `${workspaceBase}/` } : {}),
          },
        },
      }
    : {}),
  hub: {
    // The filesystem SDK needs a relative path for portable Node artifacts.
    blob: process.env.NITRO_PRESET?.startsWith("cloudflare")
      ? true
      : {
          driver: "fs",
          dir: process.env.WORKSPACE_DEV_DATA_DIR
            ? `${process.env.WORKSPACE_DEV_DATA_DIR}/blob`
            : ".data/blob",
        },
    db: {
      dialect: "sqlite",
      connection: {
        url: process.env.WORKSPACE_DEV_DATA_DIR
          ? `file:${process.env.WORKSPACE_DEV_DATA_DIR}/db/sqlite.db`
          : "file:.data/db/sqlite.db",
      },
      applyMigrationsDuringBuild: false,
      applyMigrationsDuringDev: false,
    },
  },
  runtimeConfig: {
    publicOrigin: "",
    trustedProxyIps: "",
    corsOrigins: "",
  },
  css: ["~/style.css"],
  devtools: { enabled: false },
  app: {
    head: {
      title: "Excalidraw Workspace",
      htmlAttrs: { lang: "zh-CN" },
      // Resolve the theme before styles paint, including pages rendered on the server.
      script: [
        {
          key: "editor-assets",
          tagPriority: "critical",
          innerHTML: `window.EXCALIDRAW_ASSET_PATH="${workspaceBase}/editor-assets/";`,
        },
        {
          key: "initial-theme",
          tagPriority: "critical",
          innerHTML: `(function(){var preference=document.cookie.match(/(?:^|;\\s*)workspace-theme=(light|dark|system)(?:;|$)/);var value=preference?preference[1]:"system";document.documentElement.dataset.theme=value==="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):value})()`,
        },
      ],
      link: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    },
  },
  routeRules: {
    "/": { ssr: false },
    "/draw": { redirect: "/" },
    "/c/**": { ssr: false },
    "/share/**": { ssr: false },
    "/api/**": { headers: { "cache-control": "no-store" } },
  },
  nitro: {
    externals: process.env.NITRO_PRESET?.startsWith("cloudflare")
      ? undefined
      : {
          traceInclude: [
            "@libsql/client",
            "drizzle-orm",
            "drizzle-orm/libsql",
          ].map((name) => fileURLToPath(import.meta.resolve(name))),
        },
    publicAssets: [
      {
        dir: fileURLToPath(
          new URL("./packages/excalidraw/dist/prod/fonts", import.meta.url),
        ),
        baseURL: "/editor-assets/fonts",
        maxAge: 3600,
      },
    ],
    preset: process.env.NITRO_PRESET || "node-server",
    plugins: process.env.NITRO_PRESET?.startsWith("cloudflare")
      ? []
      : [
          fileURLToPath(
            new URL("./server/collaboration/node-plugin.ts", import.meta.url),
          ),
        ],
    experimental: { tasks: true, websocket: true, openAPI: true },
    openAPI: {
      production: "prerender",
      ui: { scalar: false, swagger: false },
    },
    scheduledTasks: { "0 * * * *": ["snapshots:cleanup"] },
    cloudflare: {
      deployConfig: false,
      nodeCompat: true,
    },
  },
});
