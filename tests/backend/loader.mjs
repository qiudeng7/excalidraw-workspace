import { registerHooks } from "node:module";

// Redirect NuxtHub's generated modules in standalone H3 tests.
// Production always imports NuxtHub's real client; test databases are isolated per async scope.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@nuxthub/db") {
      return {
        url: new URL("./database.ts", import.meta.url).href,
        shortCircuit: true,
      };
    }
    if (specifier === "@nuxthub/blob") {
      return {
        url: new URL("./blobs.ts", import.meta.url).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
