import { fileURLToPath } from "node:url";

export default defineNuxtConfig({
  compatibilityDate: "2026-09-27",
  srcDir: "src/",
  serverDir: "server/",
  modules: ["@pinia/nuxt", "@nuxthub/core"],
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
          innerHTML: 'window.EXCALIDRAW_ASSET_PATH="/editor-assets/";',
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
    experimental: { tasks: true, websocket: true },
    scheduledTasks: { "0 * * * *": ["snapshots:cleanup"] },
    cloudflare: {
      deployConfig: false,
      nodeCompat: true,
    },
  },
});
