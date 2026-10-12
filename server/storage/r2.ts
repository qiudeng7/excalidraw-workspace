import type { R2Bucket } from "@cloudflare/workers-types";
import r2Driver from "unstorage/drivers/cloudflare-r2-binding";
import type { Driver } from "unstorage";

/** Keep existing slash-based R2 keys and paginate beyond the driver's first page. */
export function workspaceR2Driver(binding: R2Bucket | string = "DATA"): Driver {
  const driver = r2Driver({ binding });
  const key = (value: string) => value.replaceAll(":", "/");

  return {
    ...driver,
    hasItem: (value, options) => driver.hasItem!(key(value), options),
    getItem: (value, options) => driver.getItem!(key(value), options),
    getMeta: (value, options) => driver.getMeta!(key(value), options),
    getItemRaw: (value, options) => driver.getItemRaw!(key(value), options),
    setItemRaw: (value, data, options) =>
      driver.setItemRaw!(key(value), data, options),
    // Let Unstorage clear through our paginated getKeys/removeItem implementations.
    clear: undefined,
    setItem: (value, data, options) =>
      driver.setItem!(key(value), data, {
        ...options,
        httpMetadata: { contentType: "application/json" },
      }),
    removeItem: (value, options) => driver.removeItem!(key(value), options),
    async getKeys(base) {
      const bucket = driver.getInstance!() as R2Bucket;
      const keys: string[] = [];
      let cursor: string | undefined;

      do {
        const page = await bucket.list({
          prefix: key(base || ""),
          cursor,
          limit: 1000,
        });

        keys.push(...page.objects.map((object) => object.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);

      return keys;
    },
  };
}
