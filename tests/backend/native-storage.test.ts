import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createBlobStorage } from "@nuxthub/core/blob";
import { createDriver as fsDriver } from "@nuxthub/core/blob/drivers/fs";
import { createDriver as r2Driver } from "@nuxthub/core/blob/drivers/cloudflare-r2";
import type { R2Bucket } from "@cloudflare/workers-types";
import { readSnapshot } from "../../server/utils/snapshots";
import { withBlob } from "./blobs";

test("NuxtHub filesystem blobs read legacy snapshots without sidecar metadata", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "hub-objects-"));
  const root = resolve(directory, "objects/user/canvas/id");
  const key = "user/canvas/id/legacy.json";
  const scene = {
    elements: [{ id: "image" }],
    files: { image: "data:image/png;base64,abcd" },
  };

  try {
    await mkdir(root, { recursive: true });
    await writeFile(resolve(root, "legacy.json"), JSON.stringify(scene));
    const blob = createBlobStorage(
      fsDriver({ dir: resolve(directory, "objects") }),
    );

    assert.deepEqual(await withBlob(blob, () => readSnapshot(key, {})), scene);
    assert.deepEqual(
      (await blob.list()).blobs.map((item) => item.pathname),
      [key],
    );
    assert.ok(Number.isFinite((await blob.head(key)).uploadedAt.getTime()));
    await writeFile(resolve(root, "corrupt.json"), "partial JSON");
    await assert.rejects(
      withBlob(blob, () => readSnapshot("user/canvas/id/corrupt.json", {})),
      SyntaxError,
    );
    await blob.put("user/canvas/id/new.json", JSON.stringify(scene), {
      contentType: "application/json",
    });
    assert.deepEqual(
      JSON.parse(await readFile(resolve(root, "new.json"), "utf8")),
      scene,
    );
    assert.equal(
      (await blob.list()).blobs.some((item) =>
        item.pathname.endsWith(".$meta.json"),
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("NuxtHub R2 blobs preserve slash keys and expose every listing page", async () => {
  const uploaded = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const items = new Map(
    Array.from({ length: 1005 }, (_, index) => [
      `user/canvas/id/${index}.json`,
      JSON.stringify({ index }),
    ]),
  );
  const calls: (string | undefined)[] = [];
  const bucket = {
    async get(key: string) {
      const value = items.get(key);

      return value === undefined
        ? null
        : { arrayBuffer: async () => new TextEncoder().encode(value).buffer };
    },
    async put(key: string, value: string) {
      items.set(key, value);

      return { key, uploaded };
    },
    async delete(key: string) {
      items.delete(key);
    },
    async list({ cursor, limit }: { cursor?: string; limit: number }) {
      calls.push(cursor);
      const offset = Number(cursor || 0);

      return {
        objects: [...items.keys()]
          .slice(offset, offset + limit)
          .map((key) => ({ key, uploaded })),
        truncated: offset + limit < items.size,
        cursor: String(offset + limit),
      };
    },
  } as unknown as R2Bucket;
  const binding = "TEST_HUB_BLOB";
  const env = globalThis as unknown as Record<string, unknown>;

  env[binding] = bucket;
  try {
    const blob = createBlobStorage(r2Driver({ binding }));
    const page = await blob.list();
    const next = await blob.list({ cursor: page.cursor });

    assert.equal(page.blobs.length + next.blobs.length, 1005);
    assert.deepEqual(calls, [undefined, "1000"]);
    assert.equal(page.blobs[0]!.uploadedAt.getTime(), uploaded.getTime());
    assert.equal(next.hasMore, false);
    assert.deepEqual(
      await withBlob(blob, () => readSnapshot("user/canvas/id/0.json", {})),
      { index: 0 },
    );
    await blob.put("user/library/id/new.json", '[{"id":"item"}]');
    assert.equal(items.get("user/library/id/new.json"), '[{"id":"item"}]');
    assert.equal(items.has("user:library:id:new.json"), false);
    await blob.del(["user/library/id/new.json"]);
    assert.equal(items.has("user/library/id/new.json"), false);
  } finally {
    delete env[binding];
  }
});
