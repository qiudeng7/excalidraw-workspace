import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeStorage } from "./support/storage";
import { handleApi } from "./support/api";

test("private snapshot validators authorize before 304 and skip object reads when unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-validator-"));
  const storage = await nodeStorage(directory);
  let reads = 0;
  const blob = new Proxy(storage.blob, {
    get(target, name) {
      if (name === "get")
        return (...args: Parameters<typeof target.get>) => {
          reads++;

          return target.get(...args);
        };

      return Reflect.get(target, name);
    },
  });
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
    headers: Record<string, string> = {},
  ) => {
    const pending: Promise<unknown>[] = [];
    const response = await handleApi(
      new Request(`https://cache.test/api${path}`, {
        method,
        headers: {
          Origin: "https://cache.test",
          "X-Requested-With": "excalidraw-demo",
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      {
        database: storage.database,
        blob,
        publicOrigin: "https://cache.test",
        waitUntil: (p) => pending.push(p),
      },
    );

    await Promise.all(pending);

    return response;
  };

  try {
    const setup = await request("/setup", "POST", {
      email: "cache-admin@example.test",
      password: "CacheTestPassword123!",
    });

    assert.equal(setup.status, 200);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    const owner = ((await setup.json()) as any).user.id;
    const spaces = (await (
      await request("/workspaces", "GET", undefined, cookie)
    ).json()) as any;
    const catalog = (await (
      await request(
        `/workspaces/${spaces.workspaces[0].id}/canvases`,
        "GET",
        undefined,
        cookie,
      )
    ).json()) as any;
    const id = catalog.canvases[0].id;
    const content = { elements: [{ id: "stored" }], appState: {}, files: {} };

    assert.equal(
      (
        await request(
          `/canvases/${id}`,
          "PUT",
          { revision: 0, scene: content },
          cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          "/library",
          "PUT",
          { revision: 0, items: [{ id: "library-item" }] },
          cookie,
        )
      ).status,
      200,
    );
    for (const path of [`/canvases/${id}`, "/library"]) {
      const full = await request(path, "GET", undefined, cookie, {
        "X-Resource-Owner": owner,
      });
      const tag = full.headers.get("etag")!;

      assert.ok(tag);
      assert.equal(full.headers.get("cache-control"), "no-store");
      reads = 0;
      const unchanged = await request(path, "GET", undefined, cookie, {
        "If-None-Match": tag,
        "X-Resource-Owner": owner,
      });

      assert.equal(unchanged.status, 304);
      assert.equal(await unchanged.text(), "");
      assert.equal(
        reads,
        0,
        "conditional match must not touch the object store",
      );
      assert.equal(
        (
          await request(path, "GET", undefined, undefined, {
            "If-None-Match": tag,
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await request(path, "GET", undefined, cookie, {
            "If-None-Match": tag,
            "X-Resource-Owner": "other-account",
          })
        ).status,
        401,
      );
      assert.equal(reads, 0);
      if (path.startsWith("/canvases")) {
        await request(path, "PATCH", { name: "Renamed" }, cookie);
        assert.equal(
          (
            await request(path, "GET", undefined, cookie, {
              "If-None-Match": tag,
            })
          ).status,
          200,
          "metadata-only rename must invalidate the scene response validator",
        );
      }
    }

    const other = await request("/register", "POST", {
      email: "cache-other@example.test",
      password: "CacheTestPassword123!",
    });
    const otherCookie = other.headers.get("set-cookie")!.split(";")[0]!;
    const full = await request(`/canvases/${id}`, "GET", undefined, cookie);

    assert.equal(
      (
        await request(`/canvases/${id}`, "GET", undefined, otherCookie, {
          "If-None-Match": full.headers.get("etag")!,
        })
      ).status,
      404,
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
