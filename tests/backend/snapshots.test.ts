import { test } from "node:test";
import assert from "node:assert/strict";
import { saveSnapshot } from "../../server/utils/snapshots";
import { ApiError } from "../../server/utils/http";
import type { User } from "../../shared/contracts";
import type { H3Event } from "h3";
import { withBlob, type TestBlob } from "./blobs";
import { withDatabase, type TestDatabase } from "./database";

const user: User = {
  id: "alice",
  email: "alice@example.com",
  name: "Alice",
  role: "user",
};

test("snapshot CAS failures reclaim only the newly written object", async () => {
  for (const outcome of [
    "conflict",
    "error",
    "success",
    "write-error",
  ] as const) {
    const writes: string[] = [];
    const deletions: string[][] = [];
    const pending: Promise<unknown>[] = [];
    const objects = {
      async put(key: string) {
        writes.push(key);
        if (outcome === "write-error") throw new Error("blob write failed");
      },
      async del(keys: string[]) {
        deletions.push(keys);
      },
    } as unknown as TestBlob;
    const event = {
      context: {},
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    } as unknown as H3Event;
    const database = {
      update() {
        assert.notEqual(
          outcome,
          "write-error",
          "failed object writes never reach metadata CAS",
        );

        return {
          set() {
            return {
              where() {
                return {
                  async returning() {
                    assert.equal(
                      writes.length,
                      1,
                      "object exists before metadata CAS",
                    );
                    if (outcome === "error")
                      throw new Error("database unavailable");

                    return outcome === "success" ? [{ revision: 3 }] : [];
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as TestDatabase;
    const save = withDatabase(database, () =>
      withBlob(objects, () =>
        saveSnapshot(
          event,
          user,
          "library",
          "canvas-id",
          { revision: 2, objectKey: "old.json" },
          2,
          {},
        ),
      ),
    );

    if (outcome === "success") assert.equal((await save).revision, 3);
    else if (outcome === "write-error")
      await assert.rejects(save, /blob write failed/);
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
    assert.deepEqual(
      deletions,
      outcome === "write-error"
        ? []
        : [[outcome === "success" ? "old.json" : writes[0]]],
    );
  }
});
