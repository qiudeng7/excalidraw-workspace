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
