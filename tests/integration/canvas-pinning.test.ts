// 通过真实 H3 路由、迁移和临时 SQLite 验证账号目录置顶、CAS 与回收恢复。
// 独立登录会话和关闭重开数据库证明服务端持久化；不验证浏览器或云端 D1。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeStorage } from "./support/storage";
import { handleApi } from "./support/api";
import type { CanvasCatalog } from "../../shared/contracts";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-pinning-"));
  let storage = await nodeStorage(directory);
  const pending: Promise<unknown>[] = [];
  const request = async (
    path: string,
    method = "GET",
    data?: unknown,
    cookie = "",
    headers: Record<string, string> = {},
  ) => {
    const response = await handleApi(
      new Request(`https://pin.test/api${path}`, {
        method,
        headers: {
          Origin: "https://pin.test",
          "X-Requested-With": "excalidraw-demo",
          "Content-Type": "application/json",
          Cookie: cookie,
          ...headers,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      {
        ...storage,
        publicOrigin: "https://pin.test",
        waitUntil: (task) => pending.push(task),
      },
    );

    return {
      status: response.status,
      body:
        response.status === 304 ? await response.text() : await response.json(),
      etag: response.headers.get("etag"),
      cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    };
  };
  const credentials = {
    email: "pin-owner@example.test",
    password: "PinPassword123!",
  };
  const owner = await request("/setup", "POST", credentials);

  assert.equal(owner.status, 200);
  const spaces = await request("/workspaces", "GET", undefined, owner.cookie);
  const workspaceId = spaces.body.workspaces[0].id as string;
  const catalog = async (
    space = workspaceId,
    cookie = owner.cookie,
  ): Promise<CanvasCatalog> => {
    const result = await request(
      `/workspaces/${space}/canvases`,
      "GET",
      undefined,
      cookie,
    );

    assert.equal(result.status, 200);

    return result.body;
  };
  const pin = (
    id: string,
    pinned: boolean,
    catalogRevision: number,
    cookie = owner.cookie,
  ) =>
    request(`/canvases/${id}/pin`, "PUT", { pinned, catalogRevision }, cookie);

  return {
    request,
    catalog,
    pin,
    owner,
    workspaceId,
    credentials,
    async reopen() {
      await Promise.all(pending);
      storage.close();
      storage = await nodeStorage(directory);
    },
    async close() {
      await Promise.all(pending);
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

test("置顶改变元数据ETag而不改内容版本，旧条件读取返回新状态而新ETag返回304", async () => {
  const f = await fixture();

  try {
    const catalog = await f.catalog();
    const id = catalog.canvases[0]!.id;
    const original = await f.request(
      `/canvases/${id}`,
      "GET",
      undefined,
      f.owner.cookie,
    );

    assert.equal(original.status, 200);
    assert.ok(original.etag);
    assert.equal((await f.pin(id, true, catalog.catalogRevision)).status, 200);
    const changed = await f.request(
      `/canvases/${id}`,
      "GET",
      undefined,
      f.owner.cookie,
      { "If-None-Match": original.etag },
    );

    assert.equal(changed.status, 200);
    assert.equal(changed.body.canvas.pinned, true);
    assert.equal(changed.body.canvas.revision, original.body.canvas.revision);
    assert.equal(changed.body.canvas.updatedAt, original.body.canvas.updatedAt);
    assert.ok(changed.etag);
    assert.notEqual(changed.etag, original.etag);
    const cached = await f.request(
      `/canvases/${id}`,
      "GET",
      undefined,
      f.owner.cookie,
      { "If-None-Match": changed.etag },
    );

    assert.equal(cached.status, 304);
    assert.equal(cached.body, "");
  } finally {
    await f.close();
  }
});

test("置顶和取消按账号跨登录会话持久化，重开数据库保留且不改画布内容版本和位置", async () => {
  const f = await fixture();

  try {
    const before = await f.catalog();
    const original = before.canvases[0]!;

    assert.equal(original.pinned, false);
    const saved = await f.pin(original.id, true, before.catalogRevision);

    assert.equal(saved.status, 200);
    assert.equal(saved.body.catalogRevision, before.catalogRevision + 1);
    const second = await f.request("/login", "POST", f.credentials);

    assert.equal(second.status, 200);
    await f.reopen();
    const loaded = await f.catalog(f.workspaceId, second.cookie);

    assert.deepEqual(loaded.canvases[0], { ...original, pinned: true });
    const same = await f.pin(
      original.id,
      true,
      loaded.catalogRevision,
      second.cookie,
    );

    assert.equal(same.status, 200);
    assert.equal(same.body.catalogRevision, loaded.catalogRevision + 1);
    const cancelled = await f.pin(
      original.id,
      false,
      same.body.catalogRevision,
    );

    assert.equal(cancelled.status, 200);
    assert.deepEqual(
      (await f.catalog(f.workspaceId, second.cookie)).canvases[0],
      original,
    );
  } finally {
    await f.close();
  }
});

test("未登录和其他账号不能置顶，非法状态或旧目录版本不产生部分写入", async () => {
  const f = await fixture();

  try {
    const before = await f.catalog();
    const id = before.canvases[0]!.id;
    const bob = await f.request("/register", "POST", {
      email: "pin-other@example.test",
      password: "PinPassword123!",
    });

    assert.equal(bob.status, 200);
    assert.equal(
      (await f.pin(id, true, before.catalogRevision, "")).status,
      401,
    );
    assert.equal(
      (await f.pin(id, true, before.catalogRevision, bob.cookie)).status,
      404,
    );
    for (const pinned of [null, "true", 1]) {
      const invalid = await f.request(
        `/canvases/${id}/pin`,
        "PUT",
        { pinned, catalogRevision: before.catalogRevision },
        f.owner.cookie,
      );

      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, "INVALID_PIN_STATE");
    }

    assert.deepEqual(await f.catalog(), before);
    assert.equal((await f.pin(id, true, before.catalogRevision)).status, 200);
    const winner = await f.catalog();

    assert.equal((await f.pin(id, false, before.catalogRevision)).status, 409);
    assert.deepEqual(await f.catalog(), winner);
    const space = await f.request(
      "/workspaces",
      "POST",
      { name: "另一个空间" },
      f.owner.cookie,
    );
    const other = await f.catalog(space.body.workspace.id);

    assert.equal((await f.pin(id, false, winner.catalogRevision)).status, 200);
    assert.deepEqual(await f.catalog(space.body.workspace.id), other);
  } finally {
    await f.close();
  }
});

for (const action of ["pin", "create", "order", "delete"] as const) {
  test(`置顶与${action}使用同一目录版本时仅一方成功且无部分修改`, async () => {
    const f = await fixture();

    try {
      const before = await f.catalog();
      const id = before.canvases[0]!.id;
      const revision = before.catalogRevision;
      const competing = () => {
        if (action === "pin") {
          return f.pin(id, false, revision);
        }

        if (action === "create") {
          return f.request(
            `/workspaces/${f.workspaceId}/canvases`,
            "POST",
            { name: "并发新画布", catalogRevision: revision },
            f.owner.cookie,
          );
        }

        if (action === "order") {
          return f.request(
            `/workspaces/${f.workspaceId}/canvas-order`,
            "PUT",
            { canvasIds: [id], catalogRevision: revision },
            f.owner.cookie,
          );
        }

        return f.request(
          `/canvases/${id}`,
          "DELETE",
          { catalogRevision: revision },
          f.owner.cookie,
        );
      };
      const results = await Promise.all([
        f.pin(id, true, revision),
        competing(),
      ]);

      // 删除先提交时鉴权查询已不可见，按软删除契约返回 404；其余竞争必须 CAS 拒绝。
      if (action === "delete" && results[0]!.status === 404) {
        assert.equal(results[1]!.status, 200);
      } else {
        assert.deepEqual(
          results.map((result) => result.status).sort(),
          [200, 409],
        );
      }

      const after = await f.catalog();

      assert.equal(after.catalogRevision, revision + 1);
      if (results[0]!.status === 200) {
        assert.deepEqual(after.canvases, [
          { ...before.canvases[0], pinned: true },
        ]);
      } else if (action === "delete") {
        assert.deepEqual(after.canvases, []);
      } else {
        assert.equal(
          after.canvases.find((canvas) => canvas.id === id)!.pinned,
          false,
        );
        assert.equal(after.canvases.length, action === "create" ? 2 : 1);
      }
    } finally {
      await f.close();
    }
  });
}

test("置顶组排序只改同组槽位，取消置顶恢复基础顺序且跨组排列被拒绝", async () => {
  const f = await fixture();

  try {
    for (const name of ["B", "C", "D"]) {
      const current = await f.catalog();

      assert.equal(
        (
          await f.request(
            `/workspaces/${f.workspaceId}/canvases`,
            "POST",
            { name, catalogRevision: current.catalogRevision },
            f.owner.cookie,
          )
        ).status,
        200,
      );
    }

    let current = await f.catalog();
    const [a, b, c, d] = current.canvases.map((canvas) => canvas.id);
    const reorder = (ids: string[]) =>
      f.request(
        `/workspaces/${f.workspaceId}/canvas-order`,
        "PUT",
        { canvasIds: ids, catalogRevision: current.catalogRevision },
        f.owner.cookie,
      );

    assert.equal((await f.pin(b!, true, current.catalogRevision)).status, 200);
    current = await f.catalog();
    assert.equal((await f.pin(d!, true, current.catalogRevision)).status, 200);
    current = await f.catalog();
    assert.deepEqual(
      current.canvases.map((canvas) => canvas.id),
      [b, d, a, c],
    );
    const invalid = await reorder([a!, b!, d!, c!]);

    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "INVALID_CANVAS_ORDER");
    assert.deepEqual(await f.catalog(), current);
    assert.equal((await reorder([d!, b!, a!, c!])).status, 200);
    current = await f.catalog();
    assert.deepEqual(
      [...current.canvases]
        .sort((x, y) => x.position - y.position)
        .map((canvas) => canvas.id),
      [a, d, c, b],
    );
    assert.equal((await f.pin(b!, false, current.catalogRevision)).status, 200);
    current = await f.catalog();
    assert.equal((await f.pin(d!, false, current.catalogRevision)).status, 200);
    assert.deepEqual(
      (await f.catalog()).canvases.map((canvas) => canvas.id),
      [a, d, c, b],
    );
  } finally {
    await f.close();
  }
});

test("管理员也不能置顶其他账号私人目录的画布", async () => {
  const f = await fixture();

  try {
    const user = await f.request("/register", "POST", {
      email: "private-owner@example.test",
      password: "PinPassword123!",
    });

    assert.equal(user.status, 200);
    const spaces = await f.request(
      "/workspaces",
      "GET",
      undefined,
      user.cookie,
    );
    const id = spaces.body.workspaces[0].id as string;
    const before = await f.catalog(id, user.cookie);

    assert.equal(
      (await f.pin(before.canvases[0]!.id, true, before.catalogRevision))
        .status,
      404,
    );
    assert.deepEqual(await f.catalog(id, user.cookie), before);
  } finally {
    await f.close();
  }
});

for (const role of ["editor", "viewer"]) {
  test(`仅共享${role}不能修改所有者置顶且不会进入其私人目录`, async () => {
    const f = await fixture();

    try {
      const before = await f.catalog();
      const id = before.canvases[0]!.id;
      const email = `${role}@example.test`;
      const member = await f.request("/register", "POST", {
        email,
        password: "PinPassword123!",
      });

      assert.equal(member.status, 200);
      assert.equal(
        (
          await f.request(
            `/canvases/${id}/collaboration/members`,
            "POST",
            { email, role, viewMode: "live" },
            f.owner.cookie,
          )
        ).status,
        200,
      );
      const shared = await f.request(
        "/shared-canvases",
        "GET",
        undefined,
        member.cookie,
      );

      assert.equal(shared.status, 200);
      assert.ok(
        shared.body.canvases.some((canvas: { id: string }) => canvas.id === id),
      );
      // 建立共享会迁移协作状态；拒绝置顶的无副作用基线取自该独立操作完成后。
      const beforePin = await f.catalog();

      assert.equal(
        (await f.pin(id, true, beforePin.catalogRevision, member.cookie))
          .status,
        404,
      );
      assert.equal(
        (
          await f.request(
            `/workspaces/${f.workspaceId}/canvases`,
            "GET",
            undefined,
            member.cookie,
          )
        ).status,
        404,
      );
      assert.deepEqual(await f.catalog(), beforePin);
    } finally {
      await f.close();
    }
  });
}

test("软删除后新建再恢复产生重复位置时仍可在同组交换且不跨组串位", async () => {
  const f = await fixture();

  try {
    const initial = await f.catalog();
    const old = initial.canvases[0]!.id;

    assert.equal(
      (
        await f.request(
          `/canvases/${old}`,
          "DELETE",
          { catalogRevision: initial.catalogRevision },
          f.owner.cookie,
        )
      ).status,
      200,
    );
    let current = await f.catalog();

    assert.equal(
      (
        await f.request(
          `/workspaces/${f.workspaceId}/canvases`,
          "POST",
          { name: "新画布", catalogRevision: current.catalogRevision },
          f.owner.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request(
          `/recycle-bin/canvas/${old}`,
          "POST",
          {},
          f.owner.cookie,
        )
      ).status,
      200,
    );
    current = await f.catalog();
    assert.equal(current.canvases.length, 2);
    const reversed = current.canvases.map((canvas) => canvas.id).reverse();

    assert.equal(
      (
        await f.request(
          `/workspaces/${f.workspaceId}/canvas-order`,
          "PUT",
          { canvasIds: reversed, catalogRevision: current.catalogRevision },
          f.owner.cookie,
        )
      ).status,
      200,
    );
    const after = await f.catalog();

    assert.deepEqual(
      after.canvases.map((canvas) => canvas.id),
      reversed,
    );
    assert.equal(
      new Set(after.canvases.map((canvas) => canvas.position)).size,
      2,
    );
  } finally {
    await f.close();
  }
});

test("软删除画布拒绝置顶，恢复画布和整个空间均保留置顶状态", async () => {
  const f = await fixture();

  try {
    const before = await f.catalog();
    const id = before.canvases[0]!.id;

    assert.equal((await f.pin(id, true, before.catalogRevision)).status, 200);
    assert.equal(
      (
        await f.request(
          `/canvases/${id}`,
          "DELETE",
          { catalogRevision: before.catalogRevision + 1 },
          f.owner.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.pin(id, false, before.catalogRevision + 2)).status,
      404,
    );
    assert.equal(
      (await f.request(`/recycle-bin/canvas/${id}`, "POST", {}, f.owner.cookie))
        .status,
      200,
    );
    assert.equal(
      (await f.catalog()).canvases.find((canvas) => canvas.id === id)!.pinned,
      true,
    );
    assert.equal(
      (
        await f.request(
          `/workspaces/${f.workspaceId}`,
          "DELETE",
          undefined,
          f.owner.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.pin(
          id,
          false,
          (
            await f.request(
              `/workspaces/${f.workspaceId}/canvases`,
              "GET",
              undefined,
              f.owner.cookie,
            )
          ).body.catalogRevision ?? 0,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          `/recycle-bin/workspace/${f.workspaceId}`,
          "POST",
          {},
          f.owner.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.catalog()).canvases.find((canvas) => canvas.id === id)!.pinned,
      true,
    );
  } finally {
    await f.close();
  }
});
