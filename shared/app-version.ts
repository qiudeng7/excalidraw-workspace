declare const __APP_VERSION__: string | undefined;

/**
 * The application build version; independent of the bundled editor version.
 * Injected from package.json by nuxt.config.ts (vite.define) because Module Federation's
 * server-graph bundler cannot parse JSON module imports; "dev" outside a Vite build.
 */
export const APP_VERSION =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
