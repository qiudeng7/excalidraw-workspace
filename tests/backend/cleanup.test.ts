import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { nodeStorage } from "./storage";
import { withDatabase } from "./database";
import { withBlob, type TestBlob } from "./blobs";
import { collectOrphans } from "../../server/utils/cleanup";

test("cleanup crosses pages, checks references in batches and preserves fresh or undated objects", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "hub-cleanup-"));
  const storage = await nodeStorage(directory);
  const now = Date.now();
  const old = new Date(now - 48 * 60 * 60 * 1000);
  const items = new Map(
    Array.from({ length: 1005 }, (_, index) => [
      `alice/canvas/id/${String(index).padStart(4, "0")}.json`,
      old,
    ]),
  );
  const canvasKey = "alice/canvas/id/0010.json";
  const libraryKey = "alice/canvas/id/0900.json";

  items.set("fresh.json", new Date(now));
  items.set("unknown.json", new Date(NaN));
  items.set("orphan.tmp", old);
  const cursors: (string | undefined)[] = [];
  const blob = {
    async list({ cursor, limit }: { cursor?: string; limit: number }) {
      cursors.push(cursor);
      const remaining = [...items.keys()]
        .sort()
        .filter((key) => !cursor || key > cursor);
      const keys = remaining.slice(0, limit);

      return {
        blobs: keys.map((pathname) => ({
          pathname,
          uploadedAt: items.get(pathname)!,
        })),
        hasMore: remaining.length > limit,
        cursor: keys.at(-1),
      };
    },
    async del(keys: string[]) {
      assert.ok(keys.length <= 100);
      for (const key of keys) items.delete(key);
    },
  } as unknown as TestBlob;
  let referenceQueries = 0;
  const database = new Proxy(storage.database, {
    get(target, key) {
      if (key === "batch") {
        return (queries: Parameters<typeof target.batch>[0]) => {
          referenceQueries += queries.length;

          return target.batch(queries);
        };
      }

      const value = Reflect.get(target, key);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  try {
    await storage.queries.createAccount(
      {
        id: "alice",
        email: "alice@example.test",
        name: "Alice",
        role: "admin",
      },
      "hash",
      "space",
      "canvas",
      "2020",
    );
    await storage.queries.publishSnapshot(
      "canvas",
      "canvas",
      "alice",
      canvasKey,
      0,
      "2020",
    );
    await storage.queries.publishSnapshot(
      "library",
      "alice",
      "alice",
      libraryKey,
      0,
      "2020",
    );
    await withDatabase(database, () =>
      withBlob(blob, () => collectOrphans(now)),
    );
    assert.deepEqual(
      [...items.keys()].sort(),
      [canvasKey, libraryKey, "fresh.json", "unknown.json"].sort(),
    );
    assert.equal(cursors.length, 11);
    assert.equal(cursors[0], undefined);
    assert.ok(cursors.slice(1).every(Boolean));
    assert.equal(referenceQueries, 22);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
