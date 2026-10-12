import { AsyncLocalStorage } from "node:async_hooks";
import type { H3Event } from "h3";
import type { SnapshotStorage } from "../../server/storage/objects";

// These tests run file handlers directly through H3, outside Nitro's auto-import runtime.
// Keep each concurrent request's native storage mount isolated in the test harness.
const mounts = new AsyncLocalStorage<SnapshotStorage>();

Object.assign(globalThis, {
  useStorage(base: string) {
    if (base !== "objects" || !mounts.getStore())
      throw new Error("Missing test storage mount");

    return mounts.getStore()!;
  },
  useRuntimeConfig(event: H3Event) {
    return event.context.nitro.runtimeConfig;
  },
});

export function withNativeStorage<T>(
  storage: SnapshotStorage,
  run: () => T,
): T {
  return mounts.run(storage, run);
}
