import { fileURLToPath } from "node:url";

const nodeStorage = fileURLToPath(
  new URL("./server/storage/node.ts", import.meta.url),
);
const workerStorage = fileURLToPath(
  new URL("./server/storage/node.unavailable.ts", import.meta.url),
);

export default defineNuxtConfig({
  compatibilityDate: "2026-09-27",
  srcDir: "src/",
  alias: { "#workspace-node-storage": nodeStorage },
  serverDir: "server/",
  modules: ["@pinia/nuxt"],
  css: ["~/style.css"],
  devtools: { enabled: false },
  app: {
    head: {
      title: "Excalidraw Workspace",
      htmlAttrs: { lang: "zh-CN" },
      // Resolve the theme before styles paint, including pages rendered on the server.
      script: [
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
    "/api/**": { headers: { "cache-control": "no-store" } },
  },
  nitro: {
    preset: process.env.NITRO_PRESET || "node-server",
    // Keep node:sqlite out of the Worker bundle, even behind a dynamic import.
    alias: {
      "#workspace-node-storage":
        process.env.NITRO_PRESET === "cloudflare-module"
          ? workerStorage
          : nodeStorage,
    },
    cloudflare: {
      deployConfig: false,
      nodeCompat: true,
    },
  },
});
