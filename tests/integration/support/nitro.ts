import type { H3Event } from "h3";

// File handlers run through H3, outside Nitro's auto-import runtime.
Object.assign(globalThis, {
  useRuntimeConfig(event: H3Event) {
    return event.context.nitro.runtimeConfig;
  },
});
