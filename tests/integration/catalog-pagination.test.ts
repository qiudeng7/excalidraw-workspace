// 真实 H3、迁移和临时 SQLite 验证分页、游标、目录 CAS、局部移动及旧接口兼容。
// SQL 仅建立数据并观察迁移/查询；不替换目录实现，不覆盖浏览器或云端 D1。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { catalogFixture } from "./support/catalog-fixture";
import { nodeStorage } from "./support/storage";
import type { CanvasMeta } from "#shared/contracts";

const ids = (rows: CanvasMeta[]) => rows.map((canvas) => canvas.id);
const canonical = (rows: CanvasMeta[]) =>
  [...rows].sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      a.position - b.position ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
const conflict = (result: {
  status: number;
  body: { error: { code: string } };
}) => {
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "CATALOG_CONFLICT");
};

test("无参数保留完整目录；分页按置顶、位置、ID稳定遍历且末页停止", async () => {
  const f = await catalogFixture();

  try {
    const all = await f.catalog();

    assert.equal(all.canvases.length, 65);
    assert.deepEqual(ids(all.canvases), ids(canonical(all.canvases)));
    const collected: CanvasMeta[] = [];
    let cursor: string | undefined;

    for (const size of [30, 30, 5]) {
      const page = await f.page(30, cursor);

      assert.equal(page.canvases.length, size);
      assert.equal(page.total, 65);
      assert.equal(page.catalogRevision, all.catalogRevision);
      collected.push(...page.canvases);
      if (size === 5) assert.equal(page.nextCursor, null);
      else assert.equal(typeof page.nextCursor, "string");
      cursor = page.nextCursor ?? undefined;
    }

    assert.deepEqual(collected, all.canvases);
    assert.equal(new Set(ids(collected)).size, 65);
  } finally {
    await f.close();
  }
});

test("分页允许1到100条，带cursor不带limit默认30；非法页大小及游标被拒绝", async () => {
  const f = await catalogFixture();

  try {
    const one = await f.page(1);

    assert.equal(one.canvases.length, 1);
    const hundred = await f.page(100);

    assert.equal(hundred.canvases.length, 65);
    assert.equal(hundred.nextCursor, null);
    const defaults = await f.request(
      `/workspaces/${f.workspaceId}/canvases?cursor=${encodeURIComponent(one.nextCursor!)}`,
    );

    assert.equal(defaults.status, 200);
    assert.equal(defaults.body.canvases.length, 30);
    assert.equal(defaults.body.total, 65);
    for (const query of [
      "limit=0",
      "limit=101",
      "limit=-1",
      "limit=1.5",
      "limit=abc",
      "limit=",
      "limit=30&cursor=invalid-cursor",
    ]) {
      assert.equal(
        (await f.request(`/workspaces/${f.workspaceId}/canvases?${query}`))
          .status,
        400,
        query,
      );
    }
  } finally {
    await f.close();
  }
});

test("空目录返回零总数与终止游标，不遗漏保留完整接口兼容", async () => {
  const f = await catalogFixture(1);

  try {
    const before = await f.catalog();

    assert.equal(
      (
        await f.request(`/canvases/${before.canvases[0]!.id}`, "DELETE", {
          catalogRevision: before.catalogRevision,
        })
      ).status,
      200,
    );
    const empty = await f.page();

    assert.deepEqual(empty.canvases, []);
    assert.equal(empty.total, 0);
    assert.equal(empty.nextCursor, null);
    assert.equal(empty.catalogRevision, before.catalogRevision + 1);
    assert.deepEqual((await f.catalog()).canvases, []);
  } finally {
    await f.close();
  }
});

test("游标绑定工作空间且每页重新验证账号权限，不能跨空间或借用所有者游标", async () => {
  const f = await catalogFixture();

  try {
    const first = await f.page(1);
    const other = await f.request("/workspaces", "POST", { name: "其他空间" });

    assert.equal(other.status, 200);
    const moved = await f.request(
      `/workspaces/${other.body.workspace.id}/canvases?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );

    assert.equal(moved.status, 400);
    const user = await f.request("/register", "POST", {
      email: "reader@example.test",
      password: "CatalogPassword123!",
    });

    assert.equal(user.status, 200);
    const path = `/workspaces/${f.workspaceId}/canvases?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`;

    assert.equal((await f.request(path, "GET", undefined, "")).status, 401);
    assert.equal(
      (await f.request(path, "GET", undefined, user.cookie)).status,
      404,
    );
  } finally {
    await f.close();
  }
});

for (const action of ["create", "delete", "pin", "order", "restore"] as const) {
  test(`${action}改变目录后旧游标返回版本冲突，重新首读得到完整一致的新目录`, async () => {
    const f = await catalogFixture();

    try {
      let before = await f.catalog();
      const id = before.canvases[1]!.id;

      if (action === "restore") {
        assert.equal(
          (
            await f.request(`/canvases/${id}`, "DELETE", {
              catalogRevision: before.catalogRevision,
            })
          ).status,
          200,
        );
        before = await f.catalog();
      }

      const first = await f.page(30);
      let result;

      if (action === "create")
        result = await f.request(
          `/workspaces/${f.workspaceId}/canvases`,
          "POST",
          { name: "新建", catalogRevision: before.catalogRevision },
        );
      else if (action === "delete")
        result = await f.request(`/canvases/${id}`, "DELETE", {
          catalogRevision: before.catalogRevision,
        });
      else if (action === "pin")
        result = await f.request(`/canvases/${id}/pin?return=summary`, "PUT", {
          pinned: !before.canvases[1]!.pinned,
          catalogRevision: before.catalogRevision,
        });
      else if (action === "restore")
        result = await f.request(`/recycle-bin/canvas/${id}`, "POST", {});
      else {
        const group = before.canvases.filter((canvas) => canvas.pinned);
        const rest = before.canvases.filter((canvas) => !canvas.pinned);

        result = await f.request(
          `/workspaces/${f.workspaceId}/canvas-order`,
          "PUT",
          {
            canvasIds: [...ids(group).reverse(), ...ids(rest)],
            catalogRevision: before.catalogRevision,
          },
        );
      }

      assert.equal(result.status, 200);
      conflict(
        await f.request(
          `/workspaces/${f.workspaceId}/canvases?limit=30&cursor=${encodeURIComponent(first.nextCursor!)}`,
        ),
      );
      const after = await f.catalog();
      const refreshed = await f.page(100);

      assert.equal(refreshed.catalogRevision, after.catalogRevision);
      assert.equal(refreshed.total, after.canvases.length);
      assert.deepEqual(refreshed.canvases, after.canvases);
      assert.ok(refreshed.catalogRevision > first.catalogRevision);
    } finally {
      await f.close();
    }
  });
}

test("分页数据库读取有数量限制和范围条件，不使用OFFSET或先完整读取目录再切片", async () => {
  const f = await catalogFixture();

  try {
    const first = await f.page(30);

    f.storage.statements.length = 0;
    await f.page(30, first.nextCursor!);
    const reads = f.storage.statements.filter(
      (query) =>
        /^select\b/i.test(query) &&
        /from\s+["`]?canvases["`]?/i.test(query) &&
        !/count\s*\(/i.test(query),
    );

    assert.ok(reads.length > 0);
    assert.ok(
      reads.every((query) => /\blimit\b/i.test(query)),
      reads.join("\n"),
    );
    assert.ok(
      reads.every((query) => !/\boffset\b/i.test(query)),
      reads.join("\n"),
    );
    assert.ok(
      reads.some((query) => /\bposition\b[\s\S]*(?:>|<)/i.test(query)),
      "后续页必须按排序位置范围查询",
    );
  } finally {
    await f.close();
  }
});

test("目录并发新增时每个页面的总数、版本和首条记录来自同一快照", async () => {
  const f = await catalogFixture(35);

  try {
    const before = await f.catalog();

    for (let i = 0; i < 6; i++) {
      const revision = before.catalogRevision + i;
      const [page, created] = await Promise.all([
        f.page(30),
        f.request(`/workspaces/${f.workspaceId}/canvases`, "POST", {
          name: `并发${i}`,
          catalogRevision: revision,
        }),
      ]);

      assert.equal(created.status, 200);
      assert.equal(
        page.total,
        35 + page.catalogRevision - before.catalogRevision,
      );
      assert.ok(
        page.catalogRevision === revision ||
          page.catalogRevision === revision + 1,
      );
      // 新画布插入普通组首部，已有画布的基础位置随目录版本整体后移。
      // 同时检查元数据与版本，避免旧条目和新总数被拼成一个页面。
      assert.deepEqual(page.canvases[0], {
        ...before.canvases[0],
        position:
          before.canvases[0]!.position +
          page.catalogRevision -
          before.catalogRevision,
      });
    }
  } finally {
    await f.close();
  }
});

test("跨分页边界局部移动保留所有其他画布的相对顺序，仅提交源和目标ID", async () => {
  const f = await catalogFixture();

  try {
    const before = await f.catalog();
    const first = await f.page(30);
    const next = await f.page(30, first.nextCursor!);
    const source = first.canvases.at(-1)!;
    const target = next.canvases[0]!;

    assert.equal(source.pinned, target.pinned);
    const moved = await f.request(`/canvases/${source.id}/move`, "PUT", {
      targetId: target.id,
      placement: "after",
      catalogRevision: before.catalogRevision,
    });

    assert.equal(moved.status, 200);
    assert.deepEqual(Object.keys(moved.body).sort(), ["catalogRevision"]);
    assert.equal(moved.body.catalogRevision, before.catalogRevision + 1);
    const expected = ids(before.canvases).filter((id) => id !== source.id);

    expected.splice(expected.indexOf(target.id) + 1, 0, source.id);
    const after = await f.catalog();

    assert.deepEqual(ids(after.canvases), expected);
    assert.deepEqual(
      ids(after.canvases).filter((id) => id !== source.id),
      ids(before.canvases).filter((id) => id !== source.id),
    );
    conflict(
      await f.request(`/canvases/${source.id}/move`, "PUT", {
        targetId: target.id,
        placement: "before",
        catalogRevision: before.catalogRevision,
      }),
    );
    assert.deepEqual(await f.catalog(), after);
  } finally {
    await f.close();
  }
});

test("同组移动只交换基础槽位，取消全部置顶后保留普通组基础顺序", async () => {
  const f = await catalogFixture(1);

  try {
    for (const name of ["B", "C", "D"]) {
      const current = await f.catalog();

      assert.equal(
        (
          await f.request(`/workspaces/${f.workspaceId}/canvases`, "POST", {
            name,
            catalogRevision: current.catalogRevision,
          })
        ).status,
        200,
      );
    }

    let current = await f.catalog();
    const [a, b, c, d] = ids(current.canvases);

    for (const id of [b!, d!]) {
      assert.equal(
        (
          await f.request(`/canvases/${id}/pin?return=summary`, "PUT", {
            pinned: true,
            catalogRevision: current.catalogRevision,
          })
        ).status,
        200,
      );
      current = await f.catalog();
    }

    const moved = await f.request(`/canvases/${d}/move`, "PUT", {
      targetId: b,
      placement: "before",
      catalogRevision: current.catalogRevision,
    });

    assert.equal(moved.status, 200);
    current = await f.catalog();
    assert.deepEqual(ids(current.canvases), [d, b, a, c]);
    for (const id of [b!, d!]) {
      assert.equal(
        (
          await f.request(`/canvases/${id}/pin?return=summary`, "PUT", {
            pinned: false,
            catalogRevision: current.catalogRevision,
          })
        ).status,
        200,
      );
      current = await f.catalog();
    }

    assert.deepEqual(ids(current.canvases), [a, d, c, b]);
  } finally {
    await f.close();
  }
});

test("跨空间、跨分组、非法placement和无权限移动被拒绝且不留下部分排序", async () => {
  const f = await catalogFixture();

  try {
    const before = await f.catalog();
    const pinned = before.canvases.find((canvas) => canvas.pinned)!;
    const normal = before.canvases.find((canvas) => !canvas.pinned)!;
    const other = await f.request("/workspaces", "POST", { name: "另空间" });
    const empty = await f.catalog(other.body.workspace.id);
    const created = await f.request(
      `/workspaces/${other.body.workspace.id}/canvases`,
      "POST",
      { name: "另一空间目标", catalogRevision: empty.catalogRevision },
    );

    assert.equal(created.status, 200);
    const outside = await f.catalog(other.body.workspace.id);
    const targetId = created.body.canvas.id;

    for (const data of [
      { targetId: normal.id, placement: "before", statuses: [400] },
      { targetId, placement: "before", statuses: [400, 404] },
      { targetId: pinned.id, placement: "before", statuses: [400] },
      {
        targetId: before.canvases[1]!.id,
        placement: "sideways",
        statuses: [400],
      },
    ]) {
      const result = await f.request(`/canvases/${pinned.id}/move`, "PUT", {
        targetId: data.targetId,
        placement: data.placement,
        catalogRevision: before.catalogRevision,
      });

      assert.ok(data.statuses.includes(result.status));
      assert.deepEqual(await f.catalog(), before);
      assert.deepEqual(await f.catalog(other.body.workspace.id), outside);
    }

    const data = {
      targetId: before.canvases[1]!.id,
      placement: "after",
      catalogRevision: before.catalogRevision,
    };

    assert.equal(
      (await f.request(`/canvases/${pinned.id}/move`, "PUT", data, "")).status,
      401,
    );
    const user = await f.request("/register", "POST", {
      email: "mover@example.test",
      password: "CatalogPassword123!",
    });

    assert.equal(user.status, 200);
    assert.equal(
      (await f.request(`/canvases/${pinned.id}/move`, "PUT", data, user.cookie))
        .status,
      404,
    );
    assert.deepEqual(await f.catalog(), before);
  } finally {
    await f.close();
  }
});

test("同一目录版本的两个局部移动只有一个提交，败方无部分写入", async () => {
  const f = await catalogFixture();

  try {
    const before = await f.catalog();
    const [a, b, c] = before.canvases.filter((canvas) => canvas.pinned);
    const results = await Promise.all([
      f.request(`/canvases/${a!.id}/move`, "PUT", {
        targetId: c!.id,
        placement: "after",
        catalogRevision: before.catalogRevision,
      }),
      f.request(`/canvases/${c!.id}/move`, "PUT", {
        targetId: b!.id,
        placement: "before",
        catalogRevision: before.catalogRevision,
      }),
    ]);

    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    conflict(results.find((result) => result.status === 409)!);
    const expected = ids(before.canvases);
    const source = results[0]!.status === 200 ? a!.id : c!.id;
    const target = results[0]!.status === 200 ? c!.id : b!.id;

    expected.splice(expected.indexOf(source), 1);
    expected.splice(
      expected.indexOf(target) + (results[0]!.status === 200 ? 1 : 0),
      0,
      source,
    );
    const after = await f.catalog();

    assert.equal(after.catalogRevision, before.catalogRevision + 1);
    assert.deepEqual(ids(after.canvases), expected);
  } finally {
    await f.close();
  }
});

test("置顶summary仅返回单条元数据和版本，旧请求仍返回完整目录且内容版本不变", async () => {
  const f = await catalogFixture();

  try {
    const before = await f.catalog();
    const original = before.canvases.find((canvas) => !canvas.pinned)!;
    const result = await f.request(
      `/canvases/${original.id}/pin?return=summary`,
      "PUT",
      { pinned: true, catalogRevision: before.catalogRevision },
    );

    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), [
      "canvas",
      "catalogRevision",
    ]);
    assert.deepEqual(result.body.canvas, { ...original, pinned: true });
    assert.equal(result.body.catalogRevision, before.catalogRevision + 1);
    const legacy = await f.request(`/canvases/${original.id}/pin`, "PUT", {
      pinned: false,
      catalogRevision: result.body.catalogRevision,
    });

    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.canvases.length, 65);
    assert.deepEqual(legacy.body.canvases, before.canvases);
    assert.equal(legacy.body.catalogRevision, before.catalogRevision + 2);
  } finally {
    await f.close();
  }
});

test("追加迁移建立活动画布组合排序索引且升级既有数据库不改位置或置顶状态", async () => {
  const f = await catalogFixture(1);
  const oldDirectory = join(f.directory, "old-migrations");
  const oldDatabase = join(f.directory, "upgrade");
  let storage: Awaited<ReturnType<typeof nodeStorage>> | undefined;

  try {
    await mkdir(join(oldDirectory, "sqlite"), { recursive: true });
    await mkdir(oldDatabase, { recursive: true });
    const files = await readdir(resolve("server/db/migrations/sqlite"));
    const extra = files.filter(
      (file) => file.endsWith(".sql") && file > "0011_canvas_pins.sql",
    );

    assert.ok(extra.length > 0, "应新增迁移，不应改写历史迁移");
    for (const file of files.filter((file) => file <= "0011_canvas_pins.sql"))
      await cp(
        resolve("server/db/migrations/sqlite", file),
        join(oldDirectory, "sqlite", file),
      );
    storage = await nodeStorage(oldDatabase, oldDirectory);
    await storage.database.run(
      sql`INSERT INTO users (id,email,name,role,password_hash,created_at) VALUES ('old-owner','old@test','旧账号','user','unused','2026-01-01')`,
    );
    await storage.database.run(
      sql`INSERT INTO workspaces (id,user_id,name,created_at,updated_at) VALUES ('old-space','old-owner','旧空间','2026-01-01','2026-01-01')`,
    );
    await storage.database.run(
      sql`INSERT INTO canvases (id,workspace_id,name,created_at,updated_at,position,pinned) VALUES ('old-a','old-space','A','2026-01-01','2026-01-01',71,1), ('old-b','old-space','B','2026-01-01','2026-01-01',71,0)`,
    );
    const before = await storage.database.all(
      sql`SELECT id, position, pinned FROM canvases ORDER BY id`,
    );

    storage.close();
    storage = await nodeStorage(oldDatabase);
    assert.deepEqual(
      await storage.database.all(
        sql`SELECT id, position, pinned FROM canvases ORDER BY id`,
      ),
      before,
    );
    const indexes = await storage.database.all<{ name: string; sql: string }>(
      sql`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='canvases' AND sql IS NOT NULL`,
    );
    const index = indexes.find((entry) =>
      /workspace_id[\s\S]*pinned[\s\S]*position[\s\S]*\bid\b/i.test(
        entry.sql.replace(/["`]/g, ""),
      ),
    );

    assert.ok(index, "活动画布需包含空间、置顶、位置、ID的组合索引");
    assert.match(index.sql, /pinned["`]?\s+desc/i);
    assert.match(index.sql, /where[\s\S]*deleted_at["`]?\s+is\s+null/i);
  } finally {
    storage?.close();
    await rm(oldDirectory, { recursive: true, force: true });
    await f.close();
  }
});
