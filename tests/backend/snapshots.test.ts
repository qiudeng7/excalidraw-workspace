import { test } from "node:test";
import assert from "node:assert/strict";
import { createSnapshots } from "../../server/services/snapshots";
import { ApiError } from "../../server/services/http";
import type { User } from "../../shared/contracts";
import type { ObjectStore } from "../../server/storage/repository";

const user: User = {
  id: "alice",
  email: "alice@example.com",
  name: "Alice",
  role: "user",
};

test("snapshot CAS failures reclaim only the newly written object", async () => {
  for (const outcome of ["conflict", "error", "success"] as const) {
    const writes: string[] = [];
    const deletions: string[][] = [];
    const pending: Promise<unknown>[] = [];
    const objects: ObjectStore = {
      async read() {
        return null;
      },
      async write(key) {
        writes.push(key);
      },
      async delete(keys) {
        deletions.push(keys);
      },
      async list() {
        return { objects: [] };
      },
    };
    const snapshots = createSnapshots({
      objects,
      repository: {
        async saveSnapshot() {
          assert.equal(writes.length, 1, "object exists before metadata CAS");
          if (outcome === "error") throw new Error("database unavailable");

          return outcome === "success" ? 1 : 0;
        },
      },
      waitUntil(promise) {
        pending.push(promise);
      },
    });
    const save = snapshots.save(
      user,
      "canvas",
      "canvas-id",
      { revision: 2, objectKey: "old.json" },
      2,
      {},
    );

    if (outcome === "success") assert.equal((await save).revision, 3);
    else if (outcome === "error")
      await assert.rejects(save, /database unavailable/);
    else
      await assert.rejects(
        save,
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 409 &&
          error.code === "REVISION_CONFLICT",
      );
    await Promise.all(pending);
    assert.deepEqual(deletions, [
      [outcome === "success" ? "old.json" : writes[0]],
    ]);
  }
});
