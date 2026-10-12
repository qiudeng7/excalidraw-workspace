import { registerHooks } from "node:module";

const aliases = [
  ["~/", new URL("../../src/", import.meta.url)],
  ["@/", new URL("../../src/", import.meta.url)],
  ["#server/", new URL("../../server/", import.meta.url)],
  ["#shared/", new URL("../../shared/", import.meta.url)],
  ["~~/", new URL("../../", import.meta.url)],
  ["@@/", new URL("../../", import.meta.url)],
];

// Redirect NuxtHub's generated modules in isolated unit and H3 integration tests.
// Production always imports NuxtHub's real client; test databases are isolated per async scope.
registerHooks({
  resolve(specifier, context, nextResolve) {
    for (const [prefix, directory] of aliases) {
      if (specifier.startsWith(prefix))
        return nextResolve(
          new URL(specifier.slice(prefix.length), directory).href,
          context,
        );
    }
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
