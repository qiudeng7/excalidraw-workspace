import { test } from "node:test";
import assert from "node:assert/strict";
import { PersistentResource } from "../../src/lib/persistence";
test("persistent library captures owner and aborts old saves without acknowledging a disposed resource", async () => {
  const original = globalThis.fetch;
  let finish!: (response: Response) => void;
  let request: RequestInit | undefined;
  let changes = 0;
  globalThis.fetch = (async (_url, options) => {
    request = options;
    return new Promise<Response>((resolve) => (finish = resolve));
  }) as typeof fetch;
  const resource = new PersistentResource({
    key: "alice:library",
    path: "/api/library",
    field: "items",
    value: [{ id: "original" }],
    revision: 0,
    changed: () => changes++,
    scopeId: "isolated-test-scope",
    ownerId: "alice",
  });
  try {
    resource.update([{ id: "changed" }]);
    const saving = resource.flush();
    assert.equal(
      new Headers(request?.headers).get("X-Resource-Owner"),
      "alice",
    );
    resource.dispose();
    const count = changes;
    assert.equal(request?.signal?.aborted, true);
    // Even a transport that fails to honor abort must not acknowledge or notify an old owner.
    finish(
      new Response(JSON.stringify({ revision: 1, updatedAt: "now" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await assert.rejects(saving, { name: "AbortError" });
    assert.equal(resource.revision, 0);
    assert.equal(resource.dirty, true);
    assert.equal(changes, count);
    await assert.rejects(resource.flush(), { name: "AbortError" });
  } finally {
    resource.dispose();
    globalThis.fetch = original;
  }
});
