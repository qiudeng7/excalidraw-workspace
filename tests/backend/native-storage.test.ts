import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createStorage } from "unstorage";
import type { R2Bucket } from "@cloudflare/workers-types";
import { nodeObjectDriver } from "../../server/storage/node";
import { cloudflareStorage } from "../../server/storage/cloudflare";
import { workspaceR2Driver } from "../../server/storage/r2";
import { objectStore } from "../../server/storage/objects";

test("native filesystem storage reads legacy paths and only reclaims stale temporary writes", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "native-objects-"));
  const root = resolve(directory, "objects/user/canvas/id");
  const key = "user/canvas/id/legacy.json";
  const scene = {
    elements: [{ id: "existing-image" }],
    files: { image: "data:image/png;base64,abcd" },
  };

  try {
    await mkdir(root, { recursive: true });
    await writeFile(resolve(root, "legacy.json"), JSON.stringify(scene));
    await writeFile(resolve(root, "stale.tmp"), "partial");
    await writeFile(resolve(root, "fresh.tmp"), "partial");
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);

    await utimes(resolve(root, "stale.tmp"), stale, stale);
    const objects = objectStore(
      createStorage({ driver: nodeObjectDriver(directory) }),
    );

    assert.deepEqual(await objects.read(key), scene);
    assert.deepEqual(
      (await objects.list()).objects.map((object) => object.key),
      [key],
    );
    await assert.rejects(readFile(resolve(root, "stale.tmp")), {
      code: "ENOENT",
    });
    assert.equal(await readFile(resolve(root, "fresh.tmp"), "utf8"), "partial");
    await writeFile(resolve(root, "corrupt.json"), "partial JSON");
    await assert.rejects(
      objects.read("user/canvas/id/corrupt.json"),
      /Invalid stored snapshot JSON/,
    );
    await objects.write("user/canvas/id/new.json", scene);
    assert.deepEqual(
      JSON.parse(await readFile(resolve(root, "new.json"), "utf8")),
      scene,
    );
    await assert.rejects(
      objects.read("../outside.json"),
      /Invalid private object key/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native R2 storage preserves legacy slash keys and includes every listing page", async () => {
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

      return value === undefined ? null : { text: async () => value };
    },
    async put(key: string, value: string) {
      items.set(key, value);
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) items.delete(key);
    },
    async head(key: string) {
      return items.has(key) ? { uploaded } : null;
    },
    async list({ cursor }: { cursor?: string }) {
      calls.push(cursor);
      const offset = Number(cursor || 0);
      const objects = [...items.keys()]
        .slice(offset, offset + 1000)
        .map((key) => ({ key, uploaded }));

      return {
        objects,
        truncated: offset + 1000 < items.size,
        cursor: String(offset + 1000),
      };
    },
  } as unknown as R2Bucket;
  const native = createStorage({ driver: workspaceR2Driver(bucket) });
  const { objects } = cloudflareStorage(
    { DATA: bucket, DB: {} as never },
    native,
  );

  assert.deepEqual(await objects.read("user/canvas/id/0.json"), { index: 0 });
  const page = await objects.list();
  const next = await objects.list(page.cursor);

  assert.equal(page.objects.length + next.objects.length, 1005);
  assert.deepEqual(calls, [undefined, "1000"]);
  assert.equal(page.objects[0]!.modified, uploaded.getTime());
  assert.ok(
    next.objects.some((object) => object.key === "user/canvas/id/1004.json"),
  );
  calls.length = 0;
  assert.equal((await native.getKeys()).length, 1005);
  assert.deepEqual(calls, [undefined, "1000"]);
  await objects.write("user/library/id/new.json", [{ id: "item" }]);
  assert.equal(items.get("user/library/id/new.json"), '[{"id":"item"}]');
  assert.equal(items.has("user:library:id:new.json"), false);
  await objects.delete(["user/library/id/new.json"]);
  assert.equal(items.has("user/library/id/new.json"), false);
});
