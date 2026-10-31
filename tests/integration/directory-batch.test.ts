// 真实 H3 路由、NuxtHub 迁移与临时 SQLite 验证侧栏批量目录命令：
// 服务端权威 normalize、每 folder root 独立删除批次（canvas root 保持空批次）、
// 一次 native batch 的原子性与单次 revision、ordinal 撤销、receipt 伪造与授权、跨空间隔离。
// 不覆盖浏览器交互、选择几何与草稿保存；那些在 tests/browser/sidebar-multiselect.spec.ts。
// 每个用例都在独立的「批量测试根」文件夹内造数据，避开 fixture 预置的根画布；临时库由
// tests/integration/support/directory-fixture.ts 在 TMPDIR 下创建，不访问生产数据。
import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import {
  canvasEntry,
  directoryFixture,
  errorCode,
  folderEntry,
} from "./support/directory-fixture";
import type {
  BatchDeleteDirectoryResponse,
  BatchDirectorySummaryResponse,
  BatchMoveDirectoryResponse,
  BatchUndoDirectoryResponse,
  DeleteDirectoryUndoReceipt,
  DirectoryNode,
  MoveDirectoryUndoReceipt,
} from "#shared/directory-contracts";

type Fixture = Awaited<ReturnType<typeof directoryFixture>>;

type Ref = { kind: "folder" | "canvas"; id: string };

const ref = (kind: Ref["kind"], id: string): Ref => ({ kind, id });
const keys = (items: { kind: string; id: string }[]) =>
  items.map((item) => `${item.kind}:${item.id}`);
const batchSummary = async (
  f: Fixture,
  sources: Ref[],
  catalogRevision: number,
) =>
  f.request(`/workspaces/${f.workspaceId}/directory/batch/summary`, "POST", {
    sources,
    catalogRevision,
  });
const batchDelete = async (
  f: Fixture,
  sources: Ref[],
  catalogRevision: number,
) =>
  f.request(`/workspaces/${f.workspaceId}/directory/batch/delete`, "POST", {
    sources,
    catalogRevision,
  });
const batchMove = async (
  f: Fixture,
  input: {
    sources: Ref[];
    parentId: string | null;
    target?: Ref;
    placement: "before" | "after" | "end";
    catalogRevision: number;
  },
) =>
  f.request(`/workspaces/${f.workspaceId}/directory/batch/move`, "PUT", input);
const batchUndo = async (
  f: Fixture,
  receipt: MoveDirectoryUndoReceipt | DeleteDirectoryUndoReceipt,
  cookie?: string,
) =>
  f.request(
    `/workspaces/${f.workspaceId}/directory/batch/undo`,
    "POST",
    { receipt },
    cookie,
  );

/** 目录内混合顺序（folder/canvas 交错），用于断言移动与撤销。 */
const mix = async (f: Fixture, parentId: string) => {
  const page = await f.page(parentId);

  return keys(page.items as DirectoryNode[]);
};
/** 直接给定 position，避免 folder 与 canvas 各自计数造成的并列顺序。 */
const place = async (
  f: Fixture,
  kind: Ref["kind"],
  id: string,
  position: number,
) => {
  await f.storage.database.run(
    kind === "canvas"
      ? sql`update canvases set position = ${position} where id = ${id}`
      : sql`update folders set position = ${position} where id = ${id}`,
  );
};
const canvasRow = async (f: Fixture, id: string) =>
  (
    await f.storage.database.all(
      sql`select id as id, parent_id as parent_id, deleted_at as deleted_at,
        delete_batch_id as delete_batch_id, recycle_pending as recycle_pending,
        recycle_revision as recycle_revision
        from canvases where id = ${id}`,
    )
  )[0] as
    | {
        id: string;
        parent_id: string | null;
        deleted_at: string | null;
        delete_batch_id: string | null;
        recycle_pending: number;
        recycle_revision: number;
      }
    | undefined;
/** 只存在于隔离测试库的审计表：记录 recycle_pending 的 0→1 与 1→0，不改生产语义。 */
const installRecycleAudit = async (f: Fixture) => {
  await f.storage.database.run(
    sql.raw(
      `CREATE TABLE recycle_audit (canvas_id text, from_pending integer, to_pending integer)`,
    ),
  );
  await f.storage.database.run(
    sql.raw(
      `CREATE TRIGGER recycle_audit_trigger AFTER UPDATE ON canvases
        WHEN OLD.recycle_pending <> NEW.recycle_pending
        BEGIN INSERT INTO recycle_audit (canvas_id, from_pending, to_pending)
          VALUES (NEW.id, OLD.recycle_pending, NEW.recycle_pending); END`,
    ),
  );
};
const recycleTransitions = async (f: Fixture, id: string) =>
  (
    (await f.storage.database.all(
      sql`select from_pending as from_pending, to_pending as to_pending
        from recycle_audit where canvas_id = ${id} order by rowid`,
    )) as { from_pending: number; to_pending: number }[]
  ).map((entry) => [entry.from_pending, entry.to_pending]);
/** 目录行的完整布局快照：竞态下必须一行都不变。 */
const layoutRows = async (f: Fixture) =>
  (await f.storage.database.all(
    sql`select 'folder' as kind, id as id, parent_id as parent_id,
        position as position, coalesce(deleted_at, '') as deleted_at,
        coalesce(delete_batch_id, '') as batch_id
      from folders where workspace_id = ${f.workspaceId}
      union all
      select 'canvas' as kind, id as id, parent_id as parent_id,
        position as position, coalesce(deleted_at, '') as deleted_at,
        coalesce(delete_batch_id, '') as batch_id
      from canvases where workspace_id = ${f.workspaceId}
      order by kind, id`,
  )) as unknown[];

type BatchClient = {
  batch(queries: readonly unknown[], ...rest: unknown[]): Promise<unknown>;
};

const batchClient = (f: Fixture) =>
  (
    f.storage.database as unknown as {
      session: { client: BatchClient };
    }
  ).session.client;
/**
 * 竞态注入：在真实 libsql batch 之前用同一连接推进一次目录版本，模拟竞争方在
 * 服务端预读之后、写入之前提交。只认「写 workspaces.catalog_revision + 写 folders/canvases」
 * 的真实 SQL 形态，不按 batch 序号，也不在事务内部造假。
 */
const raceRevisionOnce = async (f: Fixture, run: () => Promise<void>) => {
  const client = batchClient(f);
  const original = client.batch;
  let injected = 0;
  let writeBatches = 0;
  const texts = (queries: readonly unknown[]) =>
    Array.from(queries, (query) =>
      typeof query === "string"
        ? query
        : ((query as { sql?: string }).sql ?? ""),
    );
  const isWriteBatch = (list: string[]) =>
    list.some(
      (text) =>
        /update\s+["`]?workspaces["`]?/i.test(text) &&
        /catalog_revision/i.test(text),
    ) &&
    list.some((text) => /update\s+["`]?(canvases|folders)["`]?/i.test(text));

  client.batch = async function (queries, ...rest) {
    if (isWriteBatch(texts(queries))) {
      writeBatches++;
      if (!injected) {
        injected++;
        await f.storage.database.run(
          sql`update workspaces set catalog_revision = catalog_revision + 1
            where id = ${f.workspaceId}`,
        );
      }
    }

    return original.apply(client, [queries, ...rest]);
  };

  try {
    await run();
  } finally {
    client.batch = original;
  }

  return { injected, writeBatches };
};
const activeCanvasCount = async (f: Fixture, parentId: string) =>
  (
    (
      await f.storage.database.all(
        sql`select count(*) as total from canvases
          where workspace_id = ${f.workspaceId} and parent_id = ${parentId}
          and deleted_at is null`,
      )
    )[0] as { total: number }
  ).total;
const spaceRevisions = async (f: Fixture) => {
  const result = f.expectStatus(await f.request("/workspaces"), 200);
  const workspaces = result.body.workspaces as {
    id: string;
    catalogRevision: number;
  }[];

  return new Map(workspaces.map((entry) => [entry.id, entry.catalogRevision]));
};
const createSpace = async (f: Fixture, name: string) => {
  const result = f.expectStatus(
    await f.request("/workspaces", "POST", { name }),
    200,
  );

  return result.body.workspace as { id: string; catalogRevision: number };
};
const expectOtherSpacesUnchanged = (
  before: Map<string, number>,
  after: Map<string, number>,
  target: string,
) => {
  for (const [id, revision] of before)
    if (id !== target)
      assert.equal(
        after.get(id),
        revision,
        `写入只能递增目标空间的 catalogRevision（${id}）`,
      );
};

test("批量 summary 按真实祖先链归一化、统计隐藏后代且不写目录", async () => {
  const f = await directoryFixture();

  try {
    const hero = await f.createFolder("批量测试根");
    const f1 = await f.createFolder("资料", hero.id);
    const f2 = await f.createFolder("子目录", f1.id);
    const inner = await f.createCanvas("子目录画布", f2.id);

    await f.createCanvas("资料画布", f1.id);
    const rootCanvas = await f.createCanvas("根画布", hero.id);
    const revision = await f.refreshRevision();
    const before = await spaceRevisions(f);
    // 直接子项只有 f1 与 rootCanvas；f2 与两张内部画布都在 f1 里。
    const heroBefore = await mix(f, hero.id);
    const layoutBefore = await layoutRows(f);

    assert.deepEqual(
      [...heroBefore].sort(),
      [`canvas:${rootCanvas.id}`, `folder:${f1.id}`].sort(),
      "hero 直接子项只有 2 项",
    );

    // f2 与 inner 都是 f1 的后代，必须被服务端合并掉，只保留请求顺序里的幸存 root。
    const result = f.expectStatus(
      await batchSummary(
        f,
        [
          ref("folder", f2.id),
          ref("canvas", inner.id),
          ref("folder", f1.id),
          ref("canvas", rootCanvas.id),
        ],
        revision,
      ),
      200,
    );
    const summary = result.body as BatchDirectorySummaryResponse;

    assert.deepEqual(keys(summary.normalizedSources), [
      `folder:${f1.id}`,
      `canvas:${rootCanvas.id}`,
    ]);
    assert.equal(summary.folderCount, 2, "根文件夹与其隐藏子文件夹各计一次");
    assert.equal(summary.canvasCount, 3, "包含隐藏子树里的画布与根画布");
    assert.equal(summary.catalogRevision, revision, "summary 不改变目录版本");
    expectOtherSpacesUnchanged(before, await spaceRevisions(f), f.workspaceId);
    assert.deepEqual(
      await mix(f, hero.id),
      heroBefore,
      "summary 后 hero 直接子项与其顺序都不变",
    );
    assert.deepEqual(
      await layoutRows(f),
      layoutBefore,
      "summary 是只读的：任何目录行的 parent/position/删除标记都不得变化",
    );
  } finally {
    await f.close();
  }
});

test("批量 summary 拒绝坏结构、缺失节点、过期版本与跨空间来源", async () => {
  const f = await directoryFixture();

  try {
    const hero = await f.createFolder("批量测试根");
    const folder = await f.createFolder("资料", hero.id);
    const canvas = await f.createCanvas("根画布", hero.id);
    const revision = await f.refreshRevision();

    for (const [label, sources, status] of [
      ["空来源", [], 400],
      ["重复来源", [ref("canvas", canvas.id), ref("canvas", canvas.id)], 400],
      [
        "超过上限",
        Array.from({ length: 101 }, (_, index) =>
          ref("canvas", `missing-${index}`),
        ),
        400,
      ],
      ["缺失节点", [ref("canvas", "ghost")], 404],
    ] as const) {
      const result = await batchSummary(f, [...sources], revision);

      f.expectStatus(result, status);
      assert.equal(
        errorCode(result),
        status === 400 ? "INVALID_DIRECTORY_BATCH" : "NOT_FOUND",
        label,
      );
    }

    const stale = await batchSummary(
      f,
      [ref("folder", folder.id)],
      revision + 9,
    );

    f.expectStatus(stale, 409);
    assert.equal(errorCode(stale), "CATALOG_CONFLICT");

    // 成员访问他人空间：跨空间不得泄露对象存在性。
    const foreign = await f.request(
      `/workspaces/${f.workspaceId}/directory/batch/summary`,
      "POST",
      { sources: [ref("canvas", canvas.id)], catalogRevision: revision },
      f.memberCookie(),
    );

    f.expectStatus(foreign, 404);
    assert.equal(errorCode(foreign), "NOT_FOUND");
    assert.equal(await f.refreshRevision(), revision, "拒绝不得写入");
  } finally {
    await f.close();
  }
});

test("批量删除给每个 folder root 独立批次、canvas root 保持空批次，只递增一次 revision", async () => {
  const f = await directoryFixture();

  try {
    await createSpace(f, "第二空间");
    const hero = await f.createFolder("批量测试根");
    const f1 = await f.createFolder("资料", hero.id);
    const inner = await f.createCanvas("资料画布", f1.id);
    const f3 = await f.createFolder("归档", hero.id);
    const grid = await f.createCanvas("归档画布", f3.id);
    const rootCanvas = await f.createCanvas("根画布", hero.id);
    const revision = await f.refreshRevision();
    const before = await spaceRevisions(f);
    const baseline = await canvasRow(f, inner.id);

    assert.ok(
      before.size >= 2,
      "至少要有目标空间与另一个空间，隔离断言才有意义",
    );
    await installRecycleAudit(f);

    const result = f.expectStatus(
      await batchDelete(
        f,
        [
          ref("folder", f1.id),
          ref("canvas", rootCanvas.id),
          ref("folder", f3.id),
        ],
        revision,
      ),
      200,
    );
    const deleted = result.body as BatchDeleteDirectoryResponse;
    const batchIds = deleted.receipt.roots.map((root) => root.deleteBatchId);

    assert.equal(deleted.catalogRevision, revision + 1, "一次写入只递增一次");
    assert.deepEqual(deleted.normalizedSources, [
      { kind: "folder", id: f1.id },
      { kind: "canvas", id: rootCanvas.id },
      { kind: "folder", id: f3.id },
    ]);
    assert.ok(batchIds[0] && batchIds[2], "folder root 都有批次号");
    assert.notEqual(batchIds[0], batchIds[2], "每个 root 各自独立批次");
    assert.equal(batchIds[1], null, "独立画布 root 保持空批次");
    assert.deepEqual(
      [...deleted.affectedCanvasIds].sort(),
      [inner.id, grid.id, rootCanvas.id].sort(),
    );
    assert.deepEqual(
      [...deleted.affectedFolderIds].sort(),
      [f1.id, f3.id].sort(),
    );

    // 回收站仍可列举：文件夹批次与独立画布（IS NULL 语义）都存在。
    const bin = await f.recycleBin();

    assert.equal(folderEntry(bin, f1.id).deleteBatchId, batchIds[0]);
    assert.equal(folderEntry(bin, f3.id).deleteBatchId, batchIds[2]);
    assert.equal(canvasEntry(bin, rootCanvas.id).kind, "canvas");

    // 持久化事实：行仍在、被标记为回收且写入了各自批次。
    // 注意 recycle_pending 不是成功后的不变式：旧接口提交后 syncRecycleRooms 成功会把它清 0，
    // 因此这里用审计触发器证明「先写 1 再清 0」，并用单调 recycleRevision + 软删除作为真实事实。
    const innerRow = await canvasRow(f, inner.id);

    assert.ok(innerRow?.deleted_at, "批量删除只做软删除");
    assert.equal(innerRow.delete_batch_id, batchIds[0]);
    assert.equal(
      innerRow.recycle_revision,
      (baseline?.recycle_revision ?? 0) + 1,
      "回收只单调递增 recycleRevision",
    );
    assert.deepEqual(
      await recycleTransitions(f, inner.id),
      [
        [0, 1],
        [1, 0],
      ],
      "先标记待同步，再由内联 outbox 同步清 0",
    );
    assert.equal(
      innerRow.recycle_pending,
      0,
      "同步成功即清 0；不能把 1 当作成功后的不变式",
    );
    assert.equal(
      (await canvasRow(f, rootCanvas.id))?.delete_batch_id,
      null,
      "独立画布 root 不写批次号，兼容既有回收站与恢复路径",
    );
    assert.equal((await f.page(hero.id)).items.length, 0);
    expectOtherSpacesUnchanged(before, await spaceRevisions(f), f.workspaceId);

    // 既有单画布恢复路径对新产生的空批次画布仍然可用。
    f.expectStatus(await f.restoreCanvas(rootCanvas.id), 200);
    assert.ok(
      (await f.page(hero.id)).items.some((item) => item.id === rootCanvas.id),
      "旧单画布恢复不被批量删除破坏",
    );
  } finally {
    await f.close();
  }
});

test("旧单 folder 恢复与彻底删除只影响自己 root，不波及同批其它 root", async () => {
  const f = await directoryFixture();

  try {
    const hero = await f.createFolder("批量测试根");
    const f1 = await f.createFolder("资料", hero.id);
    const inner = await f.createCanvas("资料画布", f1.id);
    const f3 = await f.createFolder("归档", hero.id);
    const grid = await f.createCanvas("归档画布", f3.id);
    const revision = await f.refreshRevision();

    f.expectStatus(
      await batchDelete(
        f,
        [ref("folder", f1.id), ref("folder", f3.id)],
        revision,
      ),
      200,
    );

    f.expectStatus(await f.restoreFolder(f1.id), 200);
    assert.ok((await f.page(hero.id)).items.some((item) => item.id === f1.id));
    assert.ok((await f.page(f1.id)).items.some((item) => item.id === inner.id));
    const bin = await f.recycleBin();

    assert.ok(
      bin.some((entry) => entry.kind === "folder" && entry.id === f3.id),
      "恢复 f1 不能让 f3 一起回来",
    );
    assert.ok((await canvasRow(f, grid.id))?.deleted_at);

    f.expectStatus(await f.purgeFolder(f3.id), 200);
    assert.equal(
      (await f.page(f1.id)).items.length,
      1,
      "彻底删除另一批次不得影响已恢复的子树",
    );
    assert.equal(
      await canvasRow(f, grid.id),
      undefined,
      "彻底删除只删除自己的批次",
    );
    assert.ok(await canvasRow(f, inner.id));
  } finally {
    await f.close();
  }
});

test("批量 undo 一事务恢复整组；伪造、过期与失效原位置回执零写入", async () => {
  const f = await directoryFixture();

  try {
    const hero = await f.createFolder("批量测试根");
    const parent = await f.createFolder("父级", hero.id);
    const child = await f.createFolder("子级", parent.id);
    const innerCanvas = await f.createCanvas("子级画布", child.id);
    const rootCanvas = await f.createCanvas("根画布", hero.id);
    const revision = await f.refreshRevision();
    const deleted = f.expectStatus(
      await batchDelete(
        f,
        [ref("folder", child.id), ref("canvas", rootCanvas.id)],
        revision,
      ),
      200,
    ).body as BatchDeleteDirectoryResponse;
    const receipt = deleted.receipt;

    // 伪造：真实但不在批次内的 root 搭配不存在的批次号。
    const forged = await batchUndo(f, {
      ...receipt,
      roots: [{ root: ref("folder", parent.id), deleteBatchId: "forged" }],
    } as DeleteDirectoryUndoReceipt);

    f.expectStatus(forged, 409);
    assert.equal(errorCode(forged), "DIRECTORY_UNDO_CONFLICT");
    assert.equal(
      await f.refreshRevision(),
      deleted.catalogRevision,
      "伪造零写入",
    );

    const structural = await batchUndo(f, {
      ...receipt,
      roots: "not-an-array",
    } as never);

    f.expectStatus(structural, 400);
    assert.equal(errorCode(structural), "INVALID_DIRECTORY_BATCH");

    // 成功：一次请求恢复整组。
    const undone = f.expectStatus(await batchUndo(f, receipt), 200)
      .body as BatchUndoDirectoryResponse;

    assert.equal(undone.kind, "delete");
    assert.equal(undone.catalogRevision, deleted.catalogRevision + 1);
    assert.ok(
      (await f.page(parent.id)).items.some((item) => item.id === child.id),
    );
    assert.ok(
      (await f.page(child.id)).items.some((item) => item.id === innerCanvas.id),
    );
    assert.ok(
      (await f.page(hero.id)).items.some((item) => item.id === rootCanvas.id),
    );

    // 同一 receipt 不能重放。
    f.expectStatus(await batchUndo(f, receipt), 409);

    // 过期：任何后续目录写都让快速 undo 失效。
    const revision2 = await f.refreshRevision();
    const batch2 = f.expectStatus(
      await batchDelete(f, [ref("folder", child.id)], revision2),
      200,
    ).body as BatchDeleteDirectoryResponse;

    await f.refreshRevision();
    f.expectStatus(await f.renameFolder(parent.id, "改名"), 200);
    const afterRename = await f.refreshRevision();
    const stale = await batchUndo(f, {
      ...batch2.receipt,
      expectedCatalogRevision: afterRename + 5,
    });

    f.expectStatus(stale, 409);
    assert.equal(errorCode(stale), "DIRECTORY_UNDO_CONFLICT");

    // 删除原父级也会推进目录版本，旧回执应首先因版本失效而被拒绝。
    f.expectStatus(await f.deleteFolder(parent.id), 200);
    const orphaned = await batchUndo(f, batch2.receipt);

    f.expectStatus(orphaned, 409);
    assert.equal(errorCode(orphaned), "DIRECTORY_UNDO_CONFLICT");
  } finally {
    await f.close();
  }
});

test("批量移动作为连续块插入并只递增一次 revision；语义 no-op 不写", async () => {
  const f = await directoryFixture();

  try {
    await createSpace(f, "第二空间");
    const hero = await f.createFolder("批量测试根");
    const alpha = await f.createCanvas("甲", hero.id);
    const folder = await f.createFolder("资料", hero.id);
    const beta = await f.createCanvas("乙", hero.id);
    const target = await f.createFolder("目标", hero.id);

    await place(f, "canvas", alpha.id, 0);
    await place(f, "folder", folder.id, 10);
    await place(f, "canvas", beta.id, 20);
    await place(f, "folder", target.id, 30);
    const revision = await f.refreshRevision();

    assert.deepEqual(await mix(f, hero.id), [
      `canvas:${alpha.id}`,
      `folder:${folder.id}`,
      `canvas:${beta.id}`,
      `folder:${target.id}`,
    ]);
    const before = await spaceRevisions(f);
    const moved = f.expectStatus(
      await batchMove(f, {
        sources: [ref("canvas", alpha.id), ref("folder", folder.id)],
        parentId: target.id,
        placement: "end",
        catalogRevision: revision,
      }),
      200,
    ).body as BatchMoveDirectoryResponse;

    assert.equal(moved.changed, true);
    assert.equal(moved.catalogRevision, revision + 1);
    assert.deepEqual(moved.undo?.origins, [
      {
        source: { kind: "canvas", id: alpha.id },
        parentId: hero.id,
        index: 0,
      },
      {
        source: { kind: "folder", id: folder.id },
        parentId: hero.id,
        index: 1,
      },
    ]);
    assert.deepEqual(moved.normalizedSources, [
      { kind: "canvas", id: alpha.id },
      { kind: "folder", id: folder.id },
    ]);
    assert.deepEqual(await mix(f, hero.id), [
      `canvas:${beta.id}`,
      `folder:${target.id}`,
    ]);
    assert.deepEqual(await mix(f, target.id), [
      `canvas:${alpha.id}`,
      `folder:${folder.id}`,
    ]);
    expectOtherSpacesUnchanged(before, await spaceRevisions(f), f.workspaceId);

    // no-op：把乙移动到它当前紧邻的下一项之前，最终顺序不变。
    const noop = f.expectStatus(
      await batchMove(f, {
        sources: [ref("canvas", beta.id)],
        parentId: hero.id,
        target: ref("folder", target.id),
        placement: "before",
        catalogRevision: moved.catalogRevision,
      }),
      200,
    ).body as BatchMoveDirectoryResponse;

    assert.equal(noop.changed, false);
    assert.equal(noop.catalogRevision, moved.catalogRevision, "no-op 不增版本");
    assert.equal(noop.undo, null);
    assert.deepEqual(await mix(f, hero.id), [
      `canvas:${beta.id}`,
      `folder:${target.id}`,
    ]);
  } finally {
    await f.close();
  }
});

test("批量移动撤销按原 parent 与 ordinal index 精确复原跨父、稀疏 position", async () => {
  const f = await directoryFixture();

  try {
    const hero = await f.createFolder("批量测试根");
    const box = await f.createFolder("资料", hero.id);
    const inner = await f.createCanvas("资料画布", box.id);
    const alpha = await f.createCanvas("甲", hero.id);
    const target = await f.createFolder("目标", hero.id);

    // 稀疏 position：真实顺序由 position、id、kind 决定，撤销不能依赖密集下标。
    await place(f, "folder", box.id, 30);
    await place(f, "canvas", inner.id, 7);
    await place(f, "canvas", alpha.id, 40);
    await place(f, "folder", target.id, 50);
    const original = await mix(f, hero.id);

    assert.deepEqual(original, [
      `folder:${box.id}`,
      `canvas:${alpha.id}`,
      `folder:${target.id}`,
    ]);
    const revision = await f.refreshRevision();
    const moved = f.expectStatus(
      await batchMove(f, {
        sources: [ref("canvas", inner.id), ref("canvas", alpha.id)],
        parentId: target.id,
        placement: "end",
        catalogRevision: revision,
      }),
      200,
    ).body as BatchMoveDirectoryResponse;

    assert.deepEqual(moved.undo?.origins, [
      {
        source: { kind: "canvas", id: inner.id },
        parentId: box.id,
        index: 0,
      },
      {
        source: { kind: "canvas", id: alpha.id },
        parentId: hero.id,
        index: 1,
      },
    ]);
    assert.deepEqual(await mix(f, hero.id), [
      `folder:${box.id}`,
      `folder:${target.id}`,
    ]);

    const undone = f.expectStatus(await batchUndo(f, moved.undo!), 200)
      .body as BatchUndoDirectoryResponse;

    assert.equal(undone.kind, "move");
    assert.equal(undone.catalogRevision, moved.catalogRevision + 1);
    assert.deepEqual(
      await mix(f, hero.id),
      original,
      "跨父与稀疏 position 都精确恢复",
    );
    assert.deepEqual(await mix(f, box.id), [`canvas:${inner.id}`]);
    assert.deepEqual(await mix(f, target.id), [], "撤销把来源全部移出目标");
  } finally {
    await f.close();
  }
});

test("批量移动拒绝环、超五层与非直接子项目标，且零写入", async () => {
  const f = await directoryFixture();

  try {
    const hero = await f.createFolder("批量测试根");
    const outer = await f.createFolder("一级", hero.id);
    const second = await f.createFolder("二级", outer.id);

    await f.createFolder("三级", second.id);
    const fourth = await f.createFolder("四级", second.id);
    const fifth = await f.createFolder("五级", fourth.id);
    const loose = await f.createFolder("独立", hero.id);
    const revision = await f.refreshRevision();
    const before = await mix(f, hero.id);

    for (const [label, body, code] of [
      [
        "环",
        {
          sources: [ref("folder", outer.id)],
          parentId: second.id,
          placement: "end" as const,
        },
        "INVALID_DIRECTORY_MOVE",
      ],
      [
        "超五层",
        {
          sources: [ref("folder", loose.id)],
          parentId: fifth.id,
          placement: "end" as const,
        },
        "FOLDER_DEPTH_LIMIT",
      ],
      [
        "非直接子项",
        {
          sources: [ref("folder", loose.id)],
          parentId: hero.id,
          target: ref("folder", second.id),
          placement: "before" as const,
        },
        "INVALID_DIRECTORY_MOVE",
      ],
    ] as const) {
      const result = await batchMove(f, { ...body, catalogRevision: revision });

      f.expectStatus(result, 400);
      assert.equal(errorCode(result), code, label);
    }

    const stale = await batchMove(f, {
      sources: [ref("folder", loose.id)],
      parentId: hero.id,
      placement: "end",
      catalogRevision: revision + 3,
    });

    f.expectStatus(stale, 409);
    assert.equal(errorCode(stale), "CATALOG_CONFLICT");
    assert.deepEqual(await mix(f, hero.id), before, "拒绝的移动不得改变目录");
    assert.equal(await f.refreshRevision(), revision, "拒绝的写入不得增版本");
  } finally {
    await f.close();
  }
});

test("批量移动撤销拒绝伪造、重复、越界与环回执", async () => {
  const f = await directoryFixture();

  try {
    const hero = await f.createFolder("批量测试根");
    const box = await f.createFolder("资料", hero.id);
    const leaf = await f.createFolder("子级", box.id);
    const beta = await f.createCanvas("乙", hero.id);
    const target = await f.createFolder("目标", hero.id);
    const revision = await f.refreshRevision();
    const moved = f.expectStatus(
      await batchMove(f, {
        sources: [ref("folder", box.id), ref("canvas", beta.id)],
        parentId: target.id,
        placement: "end",
        catalogRevision: revision,
      }),
      200,
    ).body as BatchMoveDirectoryResponse;
    const receipt = moved.undo!;
    const expectRejected = async (
      forged: MoveDirectoryUndoReceipt,
      label: string,
    ) => {
      const result = await batchUndo(f, forged);

      assert.ok(
        [400, 409].includes(result.status),
        `${label} 必须被拒绝：${JSON.stringify(result.body)}`,
      );
      assert.ok(
        [
          "DIRECTORY_UNDO_CONFLICT",
          "INVALID_DIRECTORY_MOVE",
          "INVALID_DIRECTORY_BATCH",
        ].includes(errorCode(result) ?? ""),
        `${label} 必须返回已登记的错误码`,
      );
      assert.equal(
        await f.refreshRevision(),
        moved.catalogRevision,
        `${label} 不得写入`,
      );
    };

    await expectRejected(
      {
        ...receipt,
        origins: [
          { source: ref("folder", box.id), parentId: leaf.id, index: 0 },
          receipt.origins[1]!,
        ],
      },
      "环：把文件夹放回自己的子文件夹",
    );
    await expectRejected(
      { ...receipt, origins: [receipt.origins[0]!, receipt.origins[0]!] },
      "重复来源",
    );
    await expectRejected(
      {
        ...receipt,
        origins: [receipt.origins[0]!, { ...receipt.origins[1]!, index: 99 }],
      },
      "越界序位",
    );
    await expectRejected(
      {
        ...receipt,
        destinationParentId: hero.id,
        origins: [
          { source: ref("canvas", beta.id), parentId: hero.id, index: 0 },
        ],
      },
      "来源已不在声明的目标",
    );
    await expectRejected(
      {
        ...receipt,
        expectedCatalogRevision: receipt.expectedCatalogRevision + 1,
      },
      "过期目录版本",
    );

    // 合法回执仍然可以撤销，证明上面的拒绝不是因为回执整体不可用。
    const undone = f.expectStatus(await batchUndo(f, receipt), 200)
      .body as BatchUndoDirectoryResponse;

    assert.equal(undone.kind, "move");
    assert.ok((await f.page(hero.id)).items.some((item) => item.id === box.id));
  } finally {
    await f.close();
  }
});

test("单个 ref 命中超过参数上限的后代数量时仍原子完成删除与撤销", async () => {
  const f = await directoryFixture();

  try {
    const folder = await f.createFolder("大文件夹");
    const now = "2026-10-31T00:00:00.000Z";
    const total = 1200;

    for (let start = 0; start < total; start += 100) {
      const chunk = Array.from(
        { length: Math.min(100, total - start) },
        (_, offset) => start + offset,
      );

      await f.storage.database.run(
        sql`insert into canvases (id, workspace_id, parent_id, name, created_at, updated_at, position)
          values ${sql.join(
            chunk.map(
              (index) =>
                sql`(${`bulk-${index}`}, ${f.workspaceId}, ${folder.id}, ${`批量画布 ${index}`}, ${now}, ${now}, ${index})`,
            ),
            sql`, `,
          )}`,
      );
    }

    const revision = await f.refreshRevision();
    const summary = f.expectStatus(
      await batchSummary(f, [ref("folder", folder.id)], revision),
      200,
    ).body as BatchDirectorySummaryResponse;

    assert.equal(summary.canvasCount, total);

    const deleted = f.expectStatus(
      await batchDelete(f, [ref("folder", folder.id)], revision),
      200,
    ).body as BatchDeleteDirectoryResponse;

    assert.equal(deleted.affectedCanvasIds.length, total);
    assert.equal(await activeCanvasCount(f, folder.id), 0);

    const undone = f.expectStatus(await batchUndo(f, deleted.receipt), 200)
      .body as BatchUndoDirectoryResponse;

    assert.equal(undone.kind, "delete");
    assert.equal(
      (undone.restoredCanvasIds ?? []).length,
      total,
      "撤销一次恢复全部后代",
    );
    assert.equal(await activeCanvasCount(f, folder.id), total);
  } finally {
    await f.close();
  }
});

test("写入中途 SQL 失败时整批回滚，目录与回收站都不留部分结果", async () => {
  const f = await directoryFixture();

  try {
    const hero = await f.createFolder("批量测试根");
    const folder = await f.createFolder("资料", hero.id);
    const victim = await f.createCanvas("触发器画布", folder.id);
    const other = await f.createCanvas("根画布", hero.id);
    const revision = await f.refreshRevision();

    await installRecycleAudit(f);
    await f.storage.database.run(
      sql.raw(
        `CREATE TRIGGER batch_delete_inject BEFORE UPDATE ON canvases
          WHEN NEW.id = '${victim.id}'
          BEGIN SELECT RAISE(ABORT, 'injected batch failure'); END`,
      ),
    );

    const failed = await batchDelete(
      f,
      [ref("folder", folder.id), ref("canvas", other.id)],
      revision,
    );

    f.expectStatus(failed, 500);
    assert.equal(errorCode(failed), "INTERNAL_ERROR");
    assert.equal(await f.refreshRevision(), revision, "回滚后版本不变");
    assert.equal((await f.page(hero.id)).items.length, 2, "目录保持原样");
    assert.deepEqual(await f.recycleBin(), [], "不得留下部分回收项");
    assert.equal((await canvasRow(f, victim.id))?.deleted_at, null);
    assert.equal((await canvasRow(f, other.id))?.deleted_at, null);
    assert.deepEqual(
      await recycleTransitions(f, victim.id),
      [],
      "回滚后不得留下任何待同步标记",
    );

    await f.storage.database.run(sql.raw("DROP TRIGGER batch_delete_inject"));
    const retried = f.expectStatus(
      await batchDelete(
        f,
        [ref("folder", folder.id), ref("canvas", other.id)],
        revision,
      ),
      200,
    ).body as BatchDeleteDirectoryResponse;

    assert.equal(retried.catalogRevision, revision + 1);
    assert.equal((await f.page(hero.id)).items.length, 0);
  } finally {
    await f.close();
  }
});

test("撤销写入前的 CAS 竞态：外部推进 revision 后必须 409 且目录行零变化", async () => {
  const f = await directoryFixture();

  try {
    const hero = await f.createFolder("批量测试根");
    const folder = await f.createFolder("资料", hero.id);

    await f.createCanvas("资料画布", folder.id);
    const revision = await f.refreshRevision();
    const deleted = f.expectStatus(
      await batchDelete(f, [ref("folder", folder.id)], revision),
      200,
    ).body as BatchDeleteDirectoryResponse;
    const before = await layoutRows(f);
    let raced: Awaited<ReturnType<typeof batchUndo>> | undefined;
    const race = await raceRevisionOnce(f, async () => {
      raced = await batchUndo(f, deleted.receipt);
    });

    // 竞争方只推进了版本；撤销必须在真实写入被 CAS 守卫拦下，而不是部分生效。
    f.expectStatus(raced!, 409);
    assert.ok(
      ["DIRECTORY_UNDO_CONFLICT", "CATALOG_CONFLICT"].includes(
        errorCode(raced!) ?? "",
      ),
      `竞态必须返回已登记的错误码：${JSON.stringify(raced!.body)}`,
    );
    assert.equal(
      await f.refreshRevision(),
      deleted.catalogRevision + 1,
      "只有竞争方推进了版本",
    );
    assert.deepEqual(await layoutRows(f), before, "竞态失败不得改动任何目录行");
    assert.ok(race.injected <= 1, "最多注入一次外部版本推进");

    // 正控：不注入时同样形状的回执可以成功，避免把失败归因于回执本身有问题。
    const second = await f.createFolder("第二批次", hero.id);
    const revision2 = await f.refreshRevision();
    const deleted2 = f.expectStatus(
      await batchDelete(f, [ref("folder", second.id)], revision2),
      200,
    ).body as BatchDeleteDirectoryResponse;
    const undone = f.expectStatus(await batchUndo(f, deleted2.receipt), 200)
      .body as BatchUndoDirectoryResponse;

    assert.equal(undone.kind, "delete");
    assert.ok(
      (await f.page(hero.id)).items.some((item) => item.id === second.id),
    );
  } finally {
    await f.close();
  }
});

test("批量命令对他人 workspace 与节点返回 404，不泄露存在性", async () => {
  const f = await directoryFixture();

  try {
    const hero = await f.createFolder("批量测试根");
    const folder = await f.createFolder("资料", hero.id);
    const canvas = await f.createCanvas("根画布", hero.id);
    const revision = await f.refreshRevision();
    const member = f.memberCookie();
    const memberSpace = await f.request(
      "/workspaces",
      "POST",
      { name: "成员空间" },
      member,
    );

    f.expectStatus(memberSpace, 200);

    for (const [path, method, body] of [
      [
        `/workspaces/${f.workspaceId}/directory/batch/summary`,
        "POST",
        { sources: [ref("folder", folder.id)], catalogRevision: revision },
      ],
      [
        `/workspaces/${f.workspaceId}/directory/batch/delete`,
        "POST",
        { sources: [ref("canvas", canvas.id)], catalogRevision: revision },
      ],
      [
        `/workspaces/${f.workspaceId}/directory/batch/move`,
        "PUT",
        {
          sources: [ref("canvas", canvas.id)],
          parentId: hero.id,
          placement: "end",
          catalogRevision: revision,
        },
      ],
    ] as const) {
      const result = await f.request(path, method, body, member);

      f.expectStatus(result, 404);
      assert.equal(errorCode(result), "NOT_FOUND");
    }

    // 成员自己的空间 + 他人节点：跨空间同样 404。
    const ownSpace = memberSpace.body.workspace as { id: string };
    const foreignNode = await f.request(
      `/workspaces/${ownSpace.id}/directory/batch/delete`,
      "POST",
      { sources: [ref("canvas", canvas.id)], catalogRevision: 0 },
      member,
    );

    f.expectStatus(foreignNode, 404);
    assert.equal(errorCode(foreignNode), "NOT_FOUND");
    assert.equal(await f.refreshRevision(), revision, "拒绝不得写入");
  } finally {
    await f.close();
  }
});
