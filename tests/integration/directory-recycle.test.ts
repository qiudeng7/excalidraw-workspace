// 真实 H3 路由、迁移和临时 SQLite 验证文件夹回收：递归摘要、整组删除/恢复、
// 不复活此前单独删除的子项、缺失父级必须显式选择位置及旧画布恢复位置校验。
// 不覆盖协作房间同步、30 天清理任务或浏览器面板。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canvasEntry,
  directoryFixture,
  errorCode,
  folderEntry,
  restoreCanvasBody,
  restoreFolderBody,
} from "./support/directory-fixture";

test("递归删除摘要只计活跃后代，整组删除隐藏子树并可按原位置恢复", async () => {
  const f = await directoryFixture();

  try {
    const root = await f.page();
    const initial = root.items[0]!;
    const a = await f.createFolder("A");
    const b = await f.createFolder("B", a.id);
    const c1 = await f.createCanvas("A 画布", a.id);
    const c2 = await f.createCanvas("B 画布", b.id);
    const c3 = await f.createCanvas("根画布");
    const beforeDelete = await f.page();
    const position = (await f.page()).items.find(
      (item) => item.id === a.id,
    )!.position;
    const summary = await f.folderSummary(a.id);

    assert.equal(summary.folderCount, 1);
    assert.equal(summary.canvasCount, 2);
    assert.equal(summary.catalogRevision, await f.currentRevision());

    const deleted = await f.deleteFolder(a.id);

    assert.equal(deleted.status, 200);
    assert.deepEqual(
      new Set(deleted.body.affectedFolderIds),
      new Set([a.id, b.id]),
    );
    assert.deepEqual(
      new Set(deleted.body.affectedCanvasIds),
      new Set([c1.id, c2.id]),
    );
    assert.equal(deleted.body.catalogRevision, summary.catalogRevision + 1);
    const after = await f.page();

    assert.equal(
      after.items.some((item) => item.id === a.id),
      false,
    );
    assert.equal(after.total, beforeDelete.total - 1);
    assert.equal(
      after.items.some((item) => item.id === initial.id),
      true,
    );
    assert.equal(
      after.items.some((item) => item.id === c3.id),
      true,
    );
    const legacy = await f.catalog();

    assert.equal(
      legacy.canvases.some((entry) => entry.id === c1.id),
      false,
    );
    assert.equal(
      legacy.canvases.some((entry) => entry.id === c2.id),
      false,
    );
    assert.equal((await f.readCanvas(c1.id)).status, 404);
    assert.equal(
      (
        await f.request(
          `/workspaces/${f.workspaceId}/directory/path?kind=canvas&id=${c1.id}`,
        )
      ).status,
      404,
    );
    const entries = await f.recycleBin();

    assert.equal(
      entries.some((entry) => entry.kind === "canvas" && entry.id === c1.id),
      false,
      "整组回收只列父文件夹，不逐项列出子画布",
    );
    assert.equal(
      entries.some((entry) => entry.kind === "folder" && entry.id === b.id),
      false,
      "子文件夹属于同一批次",
    );
    const entry = folderEntry(entries, a.id);

    assert.equal(entry.name, "A");
    assert.equal(entry.workspaceId, f.workspaceId);
    assert.equal(entry.workspaceName, "我的工作区");
    assert.equal(entry.parentId, null);
    assert.equal(entry.subtreeDepth, 2, "A 与 B 共两层文件夹");
    assert.match(entry.deleteBatchId, /\S/);
    assert.ok(Date.parse(entry.expiresAt) > Date.parse(entry.deletedAt));

    const restored = await f.restoreFolder(a.id);

    assert.equal(restored.status, 200);
    assert.deepEqual(
      new Set(restoreFolderBody(restored).restoredFolderIds),
      new Set([a.id, b.id]),
    );
    assert.deepEqual(
      new Set(restoreFolderBody(restored).restoredCanvasIds),
      new Set([c1.id, c2.id]),
    );
    const restoredRoot = await f.page();
    const restoredA = restoredRoot.items.find((item) => item.id === a.id)!;

    assert.equal(restoredA.position, position);
    assert.equal(
      (await f.path({ kind: "canvas", id: c1.id })).ancestors[0]!.id,
      a.id,
    );
    assert.equal((await f.readCanvas(c1.id)).status, 200);
    assert.equal(
      (await f.recycleBin()).some((item) => item.id === a.id),
      false,
    );
  } finally {
    await f.close();
  }
});

test("整组恢复只恢复本次批次，不复活此前已单独删除的子项", async () => {
  const f = await directoryFixture();

  try {
    const g = await f.createFolder("G");
    const keep = await f.createCanvas("保留画布", g.id);
    const gone = await f.createCanvas("此前已删除", g.id);

    assert.equal((await f.deleteCanvas(gone.id)).status, 200);
    const summary = await f.folderSummary(g.id);

    assert.equal(summary.folderCount, 0);
    assert.equal(summary.canvasCount, 1, "摘要只计活跃后代");
    const deleted = await f.deleteFolder(g.id);

    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body.affectedCanvasIds, [keep.id]);
    assert.equal(
      deleted.body.affectedCanvasIds.includes(gone.id),
      false,
      "此前已删除的画布不属于本次批次",
    );
    const entries = await f.recycleBin();

    assert.ok(folderEntry(entries, g.id));
    assert.ok(canvasEntry(entries, gone.id));
    const restored = await f.restoreFolder(g.id);

    assert.equal(restored.status, 200);
    assert.deepEqual(restoreFolderBody(restored).restoredCanvasIds, [keep.id]);
    assert.equal(
      (await f.recycleBin()).some(
        (entry) => entry.kind === "canvas" && entry.id === gone.id,
      ),
      true,
      "此前删除的子项仍留在回收站",
    );
    assert.equal((await f.readCanvas(gone.id)).status, 404);
    assert.equal(
      (await f.page(g.id)).items.some((item) => item.id === gone.id),
      false,
    );

    const later = await f.restoreCanvas(gone.id, g.id);

    assert.equal(later.status, 200);
    const body = restoreCanvasBody(later);

    assert.equal(body.canvasId, gone.id);
    assert.equal(body.parentId, g.id);
    assert.equal((await f.readCanvas(gone.id)).status, 200);
    assert.equal(
      (await f.page(g.id)).items.some((item) => item.id === gone.id),
      true,
    );
  } finally {
    await f.close();
  }
});

test("原父已彻底删除的文件夹恢复要求显式位置，选择有效文件夹后恢复", async () => {
  const f = await directoryFixture();

  try {
    const parent = await f.createFolder("原父");
    const child = await f.createFolder("待恢复", parent.id);
    const target = await f.createFolder("新位置");

    assert.equal((await f.deleteFolder(child.id)).status, 200);
    assert.equal((await f.deleteFolder(parent.id)).status, 200);
    assert.equal((await f.purgeFolder(parent.id)).status, 200);
    const before = await f.currentRevision();
    const rejected = await f.restoreFolder(child.id);

    assert.ok(
      [400, 409, 422].includes(rejected.status),
      JSON.stringify(rejected.body),
    );
    assert.equal(errorCode(rejected), "RESTORE_LOCATION_REQUIRED");
    assert.equal(await f.refreshRevision(), before);
    assert.equal((await f.page(target.id)).total, 0);
    assert.ok(folderEntry(await f.recycleBin(), child.id));

    const restored = await f.restoreFolder(child.id, target.id);

    assert.equal(restored.status, 200);
    assert.deepEqual(restoreFolderBody(restored).restoredFolderIds, [child.id]);
    const targetPage = await f.page(target.id);

    assert.equal(targetPage.total, 1);
    assert.equal(targetPage.items[0]!.id, child.id);
    assert.equal(targetPage.items[0]!.parentId, target.id);
    assert.equal(
      (await f.recycleBin()).some((item) => item.id === child.id),
      false,
    );
  } finally {
    await f.close();
  }
});

test("旧画布恢复同样校验原父位置并支持 parentId 指定新文件夹", async () => {
  const f = await directoryFixture();

  try {
    const oldParent = await f.createFolder("旧父");
    const canvas = await f.createCanvas("待恢复画布", oldParent.id);
    const target = await f.createFolder("新父");

    assert.equal((await f.deleteCanvas(canvas.id)).status, 200);
    assert.equal((await f.deleteFolder(oldParent.id)).status, 200);
    assert.equal((await f.purgeFolder(oldParent.id)).status, 200);
    const rejected = await f.restoreCanvas(canvas.id);

    assert.ok(
      [400, 409, 422].includes(rejected.status),
      JSON.stringify(rejected.body),
    );
    assert.equal(errorCode(rejected), "RESTORE_LOCATION_REQUIRED");
    assert.equal((await f.readCanvas(canvas.id)).status, 404);

    const restored = await f.restoreCanvas(canvas.id, target.id);

    assert.equal(restored.status, 200);
    const body = restoreCanvasBody(restored);

    assert.equal(body.canvasId, canvas.id);
    assert.equal(body.parentId, target.id);
    assert.equal((await f.readCanvas(canvas.id)).status, 200);
    assert.equal((await f.page(target.id)).items[0]!.id, canvas.id);
  } finally {
    await f.close();
  }
});

test("其他账号不能列出、恢复或彻底删除所有者文件夹回收项", async () => {
  const f = await directoryFixture();

  try {
    const folder = await f.createFolder("越权回收");
    const child = await f.createCanvas("子画布", folder.id);

    assert.equal((await f.deleteFolder(folder.id)).status, 200);
    const memberEntries = await f.recycleBin(f.memberCookie());

    assert.equal(
      memberEntries.some((entry) => entry.id === folder.id),
      false,
    );
    const restore = await f.restoreFolder(folder.id, null, f.memberCookie());

    assert.equal(restore.status, 404);
    assert.equal(errorCode(restore), "RECYCLE_UNAVAILABLE");
    const purge = await f.purgeFolder(folder.id, f.memberCookie());

    assert.equal(purge.status, 404);
    assert.equal(errorCode(purge), "NOT_FOUND");
    assert.ok(folderEntry(await f.recycleBin(), folder.id));
    assert.equal((await f.readCanvas(child.id)).status, 404);

    const restored = await f.restoreFolder(folder.id);

    assert.equal(restored.status, 200);
    assert.equal((await f.favorites()).length, 0, "恢复不产生额外收藏");
  } finally {
    await f.close();
  }
});
