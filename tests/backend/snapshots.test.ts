import { test } from "node:test";
import assert from "node:assert/strict";
import { saveSnapshot } from "../../server/utils/snapshots";
import { ApiError } from "../../server/utils/http";
import type { User } from "../../shared/contracts";
import type { H3Event } from "h3";
import { withNativeStorage } from "./nitro";

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
    const objects = {
      async getItem() {
        return null;
      },
      async setItem(key: string) {
        writes.push(key);
      },
      async removeItem(key: string) {
        deletions.push([key]);
      },
      async getKeys() {
        return [];
      },
      getMeta() {
        return {};
      },
    };
    const event = {
      context: {
        repository: async () => ({
          async saveSnapshot() {
            assert.equal(writes.length, 1, "object exists before metadata CAS");
            if (outcome === "error") throw new Error("database unavailable");

            return outcome === "success" ? 1 : 0;
          },
        }),
      },
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    } as unknown as H3Event;
    const save = withNativeStorage(objects, () =>
      saveSnapshot(
        event,
        user,
        "canvas",
        "canvas-id",
        { revision: 2, objectKey: "old.json" },
        2,
        {},
      ),
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
