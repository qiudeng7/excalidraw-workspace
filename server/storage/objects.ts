import type { ObjectStore } from "./ports";

/** Minimal native storage surface, shared with Nitro's inferred storage types. */
export interface SnapshotStorage {
  getItem(key: string): Promise<unknown | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getKeys(): Promise<string[]>;
  getMeta(
    key: string,
  ):
    | { mtime?: Date | string | number }
    | Promise<{ mtime?: Date | string | number }>;
}

/** Translate Unstorage's colon keys back to the existing private object paths. */
export function objectStore(
  storage: SnapshotStorage,
  list?: ObjectStore["list"],
  remove?: ObjectStore["delete"],
): ObjectStore {
  function validate(key: string) {
    if (!/^[a-zA-Z0-9/-]+\.json$/.test(key) || key.includes(".."))
      throw new Error("Invalid private object key");

    return key;
  }

  return {
    async read(key) {
      const value = await storage.getItem(validate(key));

      if (value !== null && typeof value !== "object")
        throw new Error("Invalid stored snapshot JSON");

      return value;
    },
    write: (key, value) =>
      storage.setItem(validate(key), JSON.stringify(value)),
    async delete(keys) {
      keys.forEach(validate);
      if (remove) return remove(keys);
      await Promise.all(keys.map((key) => storage.removeItem(validate(key))));
    },
    list:
      list ??
      async function () {
        const allKeys = await storage.getKeys();

        // Interrupted atomic writes can leave temp files; preserve the existing 24h grace period.
        for (const key of allKeys.filter((key) => key.endsWith(".tmp"))) {
          const meta = await storage.getMeta(key);

          if (
            meta.mtime &&
            new Date(meta.mtime).getTime() < Date.now() - 24 * 60 * 60 * 1000
          )
            await storage.removeItem(key);
        }

        const keys = allKeys.filter((key) => key.endsWith(".json"));
        const objects = await Promise.all(
          keys.map(async (key) => {
            const meta = await storage.getMeta(key);
            const modified = meta.mtime ? new Date(meta.mtime).getTime() : NaN;

            // Unknown timestamps must never make an object eligible for garbage collection.
            return {
              key: key.replaceAll(":", "/"),
              modified: Number.isFinite(modified) ? modified : Date.now(),
            };
          }),
        );

        return { objects };
      },
  };
}
