import { AsyncLocalStorage } from "node:async_hooks";
import type { BlobStorage } from "@nuxthub/core/blob";

export type TestBlob = Pick<BlobStorage, "get" | "put" | "del" | "list">;

const stores = new AsyncLocalStorage<TestBlob>();

// Only standalone tests replace NuxtHub's generated singleton.
export const blob = new Proxy({} as TestBlob, {
  get(_target, key) {
    const store = stores.getStore();

    if (!store) throw new Error("Missing test blob storage");
    const value = Reflect.get(store, key);

    return typeof value === "function" ? value.bind(store) : value;
  },
});

export function withBlob<T>(store: TestBlob, run: () => T): T {
  return stores.run(store, run);
}
