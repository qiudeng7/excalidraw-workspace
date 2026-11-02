// 真实 H3 路由、迁移和临时 SQLite 验证侧栏目录：根混排、5 层、子树移动、收藏、
// 跨页路径、授权、目录版本冲突及旧画布迁移。API 替身和浏览器不在本文件范围。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { directoryFixture, errorCode } from "./support/directory-fixture";
import { nodeStorage } from "./support/storage";
import { handleApi } from "./support/api";
import { digest } from "#server/utils/passwords";
import type { DirectoryNode } from "#shared/directory-contracts";

const origin = "https://directory-upgrade.test";

const ids = (items: DirectoryNode[]) => items.map((item) => item.id);
const nodeIds = (items: DirectoryNode[]) =>
  items.map((item) => `${item.kind}:${item.id}`);
const order = (items: DirectoryNode[]) => {
  for (let index = 1; index < items.length; index++) {
    const previous = items[index - 1]!;
    const current = items[index]!;

    assert.ok(
      previous.position < current.position ||
        (previous.position === current.position && previous.id < current.id),
      `目录应按 position、id 稳定排列：${previous.id} 在 ${current.id} 前`,
    );
  }
};

test("根目录混排文件夹与画布，子目录独立加载且旧画布目录仍可读", async () => {
  const f = await directoryFixture();

  try {
    const root = await f.page();
    const initial = root.items.find((item) => item.kind === "canvas")!;

    assert.equal(initial.parentId, null);
    assert.equal(initial.kind, "canvas");
    const folder = await f.createFolder("设计资料");
    const canvas = await f.createCanvas("根画布");

    assert.equal(folder.kind, "folder");
    assert.equal(folder.parentId, null);
    assert.equal(folder.depth, 1);
    assert.equal(folder.childCount, 0);
    assert.equal(folder.favorite, false);

    const mixed = await f.page();

    assert.equal(mixed.total, 3);
    assert.deepEqual(
      new Set(mixed.items.map((item) => item.kind)),
      new Set(["folder", "canvas"]),
    );
    order(mixed.items);

    const created = mixed.items.find(
      (item) => item.kind === "canvas" && item.id === canvas.id,
    )!;

    assert.equal(created.kind, "canvas");
    assert.equal(created.parentId, null);
    assert.equal(created.name, "根画布");
    assert.equal(created.favorite, false);
    assert.equal(created.kind === "canvas" && created.canvas.id, canvas.id);
    assert.equal(
      created.kind === "canvas" && "parentId" in created.canvas,
      false,
      "CanvasMeta 不携带 parentId",
    );
    assert.equal(created.kind === "canvas" && created.canvas.pinned, false);

    const childCanvas = await f.createCanvas("文件夹里的画布", folder.id);
    const childPage = await f.page(folder.id);

    assert.equal(childPage.parentId, folder.id);
    assert.equal(childPage.total, 1);
    assert.deepEqual(ids(childPage.items), [childCanvas.id]);

    const parent = (await f.page()).items.find(
      (item) => item.id === folder.id,
    )!;

    assert.equal(parent.kind === "folder" && parent.childCount, 1);
    const all = await f.page(undefined, { limit: 100 });

    assert.equal(all.total, 3);
    const legacy = await f.catalog();

    assert.deepEqual(
      new Set(legacy.canvases.map((entry) => entry.id)),
      new Set([initial.id, canvas.id, childCanvas.id]),
      "旧纯画布目录仍包含各层画布",
    );
    assert.equal(
      legacy.canvases.some((entry) => entry.id === folder.id),
      false,
      "文件夹不进入旧画布目录",
    );
  } finally {
    await f.close();
  }
});

test("同父混排后新建画布只插入自身，不改变已有文件与其他父级的相对顺序", async () => {
  const f = await directoryFixture();

  try {
    const a = await f.createFolder("A");
    const c1 = await f.createCanvas("C1");
    const b = await f.createFolder("B");
    const c2 = await f.createCanvas("C2");
    const p = await f.createFolder("P");
    const other = await f.createFolder("Other");
    const q1 = await f.createCanvas("Q1", other.id);
    const q2 = await f.createCanvas("Q2", other.id);
    const x = await f.createCanvas("X", p.id);
    const y = await f.createFolder("Y", p.id);
    const z = await f.createCanvas("Z", p.id);

    await f.move({
      source: { kind: "folder", id: a.id },
      parentId: null,
      target: { kind: "canvas", id: c1.id },
      placement: "before",
    });
    await f.move({
      source: { kind: "canvas", id: c1.id },
      parentId: null,
      target: { kind: "folder", id: b.id },
      placement: "before",
    });
    await f.move({
      source: { kind: "folder", id: b.id },
      parentId: null,
      target: { kind: "canvas", id: c2.id },
      placement: "before",
    });
    await f.move({
      source: { kind: "canvas", id: x.id },
      parentId: p.id,
      target: { kind: "folder", id: y.id },
      placement: "before",
    });
    await f.move({
      source: { kind: "canvas", id: z.id },
      parentId: p.id,
      target: { kind: "folder", id: y.id },
      placement: "after",
    });
    await f.move({
      source: { kind: "canvas", id: q1.id },
      parentId: other.id,
      target: { kind: "canvas", id: q2.id },
      placement: "before",
    });

    const rootBefore = ids((await f.page()).items);
    const childBefore = ids((await f.page(p.id)).items);
    const otherBefore = ids((await f.page(other.id)).items);
    const createdRoot = await f.createCanvas("新根画布");
    const rootAfter = ids((await f.page()).items);

    assert.deepEqual(
      rootAfter.filter((id) => rootBefore.includes(id)),
      rootBefore,
      "新建根画布不得改变已有根节点相对顺序",
    );
    assert.deepEqual(rootAfter, [createdRoot.id, ...rootBefore]);
    assert.deepEqual(
      ids((await f.page()).items),
      rootAfter,
      "重新读取仍在根目录顶部",
    );
    assert.deepEqual(
      ids((await f.page(other.id)).items),
      otherBefore,
      "新建根画布不得改变其他父级顺序",
    );
    assert.deepEqual(ids((await f.page(p.id)).items), childBefore);

    const createdChild = await f.createCanvas("P 新画布", p.id);
    const childAfter = ids((await f.page(p.id)).items);

    assert.deepEqual(childAfter, [createdChild.id, ...childBefore]);
    assert.deepEqual(
      ids((await f.page(p.id)).items),
      childAfter,
      "重新读取仍在所属文件夹顶部",
    );
    assert.deepEqual(
      childAfter.filter((id) => childBefore.includes(id)),
      childBefore,
      "在子文件夹新建画布不得改变同父已有节点顺序",
    );
    assert.deepEqual(
      ids((await f.page()).items),
      rootAfter,
      "在子文件夹新建画布不得改变根级顺序",
    );
    assert.deepEqual(ids((await f.page(other.id)).items), otherBefore);
  } finally {
    await f.close();
  }
});

test("文件夹最多 5 层，第 5 层可建画布但不能建子文件夹", async () => {
  const f = await directoryFixture();

  try {
    let parentId: string | null = null;
    let leaf: Extract<DirectoryNode, { kind: "folder" }> | undefined;

    let rootFolder: Extract<DirectoryNode, { kind: "folder" }> | undefined;

    for (let depth = 1; depth <= 5; depth++) {
      leaf = await f.createFolder(`第${depth}层`, parentId);
      assert.equal(leaf.depth, depth);
      assert.equal(leaf.subtreeDepth, 1, "新建叶文件夹只含自身");
      assert.equal(leaf.parentId, parentId);
      rootFolder ??= leaf;
      parentId = leaf.id;
    }

    const fullTree = await f.path({ kind: "folder", id: rootFolder!.id });

    assert.equal(
      fullTree.item.kind === "folder" && fullTree.item.subtreeDepth,
      5,
    );

    const deepestCanvas = await f.createCanvas("第5层画布", leaf!.id);
    const childPage = await f.page(leaf!.id);

    assert.equal(childPage.total, 1);
    assert.deepEqual(ids(childPage.items), [deepestCanvas.id]);

    const before = await f.currentRevision();
    const rejected = await f.request(
      `/workspaces/${f.workspaceId}/folders`,
      "POST",
      {
        name: "第6层",
        parentId: leaf!.id,
        catalogRevision: before,
      },
    );

    assert.equal(rejected.status, 400);
    assert.equal(errorCode(rejected), "FOLDER_DEPTH_LIMIT");
    assert.equal(await f.refreshRevision(), before);
    assert.equal((await f.page(leaf!.id)).total, 1, "失败不得留下子文件夹");

    const path = await f.path({ kind: "canvas", id: deepestCanvas.id });

    assert.deepEqual(
      path.ancestors.map((item) => item.name),
      ["第1层", "第2层", "第3层", "第4层", "第5层"],
    );
    assert.equal(path.pages.length, 6, "5 层祖先加目标页");
    assert.equal(path.pages[0]!.items[0]!.name, "第1层");
    assert.equal(path.pages[5]!.items[0]!.id, deepestCanvas.id);
    assert.equal(path.pages[0]!.hasPrevious, true);
  } finally {
    await f.close();
  }
});

test("目录分页按位置和 ID 稳定混排，游标绑定父目录和目录版本", async () => {
  const f = await directoryFixture();

  try {
    for (let index = 0; index < 32; index++) {
      if (index % 3 === 0) await f.createFolder(`分页文件夹 ${index}`);
      else await f.createCanvas(`分页画布 ${index}`);
    }

    const first = await f.page(undefined, { limit: 30 });

    assert.equal(first.total, 33);
    assert.equal(first.items.length, 30);
    assert.ok(first.nextCursor);
    order(first.items);
    const second = await f.page(undefined, {
      limit: 30,
      cursor: first.nextCursor,
    });

    assert.equal(second.items.length, 3);
    assert.equal(second.nextCursor, null);
    order(second.items);
    const combined = [...first.items, ...second.items];

    assert.equal(new Set(ids(combined)).size, 33);
    const all = await f.page(undefined, { limit: 100 });

    assert.equal(all.nextCursor, null);
    assert.deepEqual(nodeIds(all.items), nodeIds(combined));

    const folder = await f.createFolder("游标容器");
    const parentCursor = await f.page(undefined, { limit: 5 });
    const wrongParent = await f.request(
      `/workspaces/${f.workspaceId}/directory?parentId=${folder.id}&limit=5&cursor=${parentCursor.nextCursor}`,
    );

    assert.equal(wrongParent.status, 400);
    assert.equal(errorCode(wrongParent), "INVALID_CURSOR");

    const stale = await f.page(undefined, { limit: 5 });
    const revisionBefore = await f.currentRevision();

    await f.createFolder("使旧游标过期");
    const conflict = await f.request(
      `/workspaces/${f.workspaceId}/directory?limit=5&cursor=${stale.nextCursor}`,
    );

    assert.equal(conflict.status, 409);
    assert.equal(errorCode(conflict), "CATALOG_CONFLICT");
    assert.equal(await f.currentRevision(), revisionBefore + 1);

    for (const limit of ["0", "101"]) {
      const invalid = await f.request(
        `/workspaces/${f.workspaceId}/directory?limit=${limit}`,
      );

      assert.equal(invalid.status, 400);
      assert.equal(errorCode(invalid), "INVALID_PAGINATION");
    }
  } finally {
    await f.close();
  }
});

test("按 ID 路径返回祖先与逐层定位页，跳过前置同层项但仍可回到开头", async () => {
  const f = await directoryFixture();

  try {
    const x = await f.createCanvas("根前项");
    const a = await f.createFolder("A");
    const y = await f.createCanvas("根后项");
    const c = await f.createCanvas("C", a.id);
    const b = await f.createFolder("B", a.id);
    const d = await f.createCanvas("D", a.id);
    const e = await f.createCanvas("E", b.id);
    const target = await f.createCanvas("F", b.id);
    const g = await f.createCanvas("G", b.id);

    await f.move({
      source: { kind: "folder", id: a.id },
      parentId: null,
      target: { kind: "canvas", id: y.id },
      placement: "before",
    });
    await f.move({
      source: { kind: "canvas", id: x.id },
      parentId: null,
      target: { kind: "folder", id: a.id },
      placement: "before",
    });
    await f.move({
      source: { kind: "canvas", id: c.id },
      parentId: a.id,
      target: { kind: "folder", id: b.id },
      placement: "before",
    });
    await f.move({
      source: { kind: "canvas", id: d.id },
      parentId: a.id,
      target: { kind: "folder", id: b.id },
      placement: "after",
    });
    await f.move({
      source: { kind: "canvas", id: e.id },
      parentId: b.id,
      target: { kind: "canvas", id: target.id },
      placement: "before",
    });
    await f.move({
      source: { kind: "canvas", id: g.id },
      parentId: b.id,
      target: { kind: "canvas", id: target.id },
      placement: "after",
    });

    const path = await f.path({ kind: "canvas", id: target.id });

    assert.equal(path.item.id, target.id);
    assert.deepEqual(
      path.ancestors.map((item) => item.name),
      ["A", "B"],
    );
    assert.equal(path.pages.length, 3);
    assert.equal(path.pages[0]!.parentId, null);
    assert.equal(path.pages[0]!.items[0]!.name, "A");
    assert.equal(path.pages[0]!.total, 4);
    assert.equal(path.pages[0]!.hasPrevious, true);
    assert.ok(
      path.pages[0]!.items.some((item) => item.id === y.id),
      "定位页包含目标父级后的同层项",
    );
    assert.equal(path.pages[1]!.parentId, a.id);
    assert.equal(path.pages[1]!.items[0]!.name, "B");
    assert.equal(path.pages[1]!.total, 3);
    assert.equal(path.pages[1]!.hasPrevious, true);
    assert.equal(path.pages[2]!.parentId, b.id);
    assert.equal(path.pages[2]!.items[0]!.id, target.id);
    assert.equal(path.pages[2]!.total, 3);
    assert.equal(path.pages[2]!.hasPrevious, true);

    const rootPath = await f.path({ kind: "canvas", id: y.id });

    assert.deepEqual(rootPath.ancestors, []);
    assert.equal(rootPath.item.id, y.id);
    assert.equal(rootPath.pages.length, 1);
    assert.equal(rootPath.pages[0]!.items[0]!.id, y.id);
    assert.equal(rootPath.pages[0]!.hasPrevious, true);

    const missing = await f.request(
      `/workspaces/${f.workspaceId}/directory/path?kind=canvas&id=missing`,
    );

    assert.equal(missing.status, 404);
    assert.equal(errorCode(missing), "NOT_FOUND");
  } finally {
    await f.close();
  }
});

test("收藏是独立排序的快捷引用，不改变树位置并兼容旧 pinned 字段", async () => {
  const f = await directoryFixture();

  try {
    const folder = await f.createFolder("收藏文件夹");
    const canvas = await f.createCanvas("收藏画布");
    const treeBefore = nodeIds((await f.page()).items);

    assert.equal((await f.favorites()).length, 0);
    assert.equal(
      (await f.favorite({ kind: "canvas", id: canvas.id })).status,
      200,
    );
    assert.equal(
      (await f.favorite({ kind: "folder", id: folder.id })).status,
      200,
    );

    const favorites = await f.favorites();

    assert.equal(favorites.length, 2);
    assert.deepEqual(
      new Set(favorites.map((item) => item.id)),
      new Set([canvas.id, folder.id]),
    );
    assert.deepEqual(nodeIds((await f.page()).items), treeBefore);
    const folderFavorite = favorites.find((item) => item.kind === "folder")!;

    assert.equal(folderFavorite.id, folder.id);
    assert.equal(folderFavorite.parentId, null);
    assert.equal(
      folderFavorite.position,
      (await f.page()).items.find((item) => item.id === folder.id)!.position,
    );
    assert.deepEqual(
      (await f.path({ kind: "folder", id: folder.id })).ancestors,
      [],
    );

    assert.equal(
      (
        await f.reorderFavorites(
          { kind: "canvas", id: canvas.id },
          { kind: "folder", id: folder.id },
          "before",
        )
      ).status,
      200,
    );
    assert.deepEqual(ids(await f.favorites()), [canvas.id, folder.id]);
    assert.equal(
      (
        await f.reorderFavorites(
          { kind: "folder", id: folder.id },
          { kind: "canvas", id: canvas.id },
          "before",
        )
      ).status,
      200,
    );
    assert.deepEqual(ids(await f.favorites()), [folder.id, canvas.id]);
    assert.deepEqual(nodeIds((await f.page()).items), treeBefore);

    const legacyCanvas = await f.readCanvas(canvas.id);

    assert.equal(legacyCanvas.status, 200);
    assert.equal(legacyCanvas.body.canvas.pinned, true);
    const legacyCatalog = await f.catalog();

    assert.equal(
      legacyCatalog.canvases.find((item) => item.id === canvas.id)?.pinned,
      true,
    );
    assert.equal(
      (await f.favorite({ kind: "canvas", id: canvas.id }, false)).status,
      200,
    );
    assert.deepEqual(ids(await f.favorites()), [folder.id]);
    assert.equal((await f.readCanvas(canvas.id)).body.canvas.pinned, false);
    assert.deepEqual(nodeIds((await f.page()).items), treeBefore);
  } finally {
    await f.close();
  }
});

test("移动子树更新深度并拒绝循环、超深、跨空间与跨用户，失败不留下部分结果", async () => {
  const f = await directoryFixture();

  try {
    const g = await f.createFolder("G");
    const a = await f.createFolder("A");
    const b = await f.createFolder("B", a.id);
    const c = await f.createFolder("C", b.id);
    const d = await f.createFolder("D", c.id);
    const e = await f.createFolder("E", d.id);
    const leafCanvas = await f.createCanvas("E 画布", e.id);

    const moved = await f.move({
      source: { kind: "folder", id: b.id },
      parentId: g.id,
      placement: "end",
    });

    assert.equal(moved.status, 200);
    const leafPath = await f.path({ kind: "canvas", id: leafCanvas.id });

    assert.deepEqual(
      leafPath.ancestors.map((item) => item.name),
      ["G", "B", "C", "D", "E"],
    );
    for (const ancestor of leafPath.ancestors) {
      assert.equal(ancestor.kind, "folder");
      assert.equal(
        ancestor.kind === "folder" && ancestor.depth,
        ["G", "B", "C", "D", "E"].indexOf(ancestor.name) + 1,
      );
    }

    const movedB = leafPath.ancestors.find((item) => item.id === b.id)!;

    assert.equal(movedB.kind === "folder" && movedB.subtreeDepth, 4);

    const beforeCycle = await f.currentRevision();
    const cycle = await f.move({
      source: { kind: "folder", id: g.id },
      parentId: e.id,
      placement: "end",
    });

    assert.equal(cycle.status, 400);
    assert.equal(errorCode(cycle), "INVALID_DIRECTORY_MOVE");
    assert.equal(await f.refreshRevision(), beforeCycle);
    assert.deepEqual(
      (await f.path({ kind: "canvas", id: leafCanvas.id })).ancestors.map(
        (item) => item.name,
      ),
      ["G", "B", "C", "D", "E"],
    );

    const p1 = await f.createFolder("P1");
    const p2 = await f.createFolder("P2", p1.id);
    const p3 = await f.createFolder("P3", p2.id);

    assert.ok(p3);
    let t: Extract<DirectoryNode, { kind: "folder" }> | undefined;

    for (let depth = 1; depth <= 5; depth++)
      t = await f.createFolder(`T${depth}`, t?.id ?? null);
    const beforeDepth = await f.currentRevision();
    const tooDeep = await f.move({
      source: { kind: "folder", id: p2.id },
      parentId: t!.id,
      placement: "end",
    });

    assert.equal(tooDeep.status, 400);
    assert.equal(errorCode(tooDeep), "FOLDER_DEPTH_LIMIT");
    assert.equal(await f.refreshRevision(), beforeDepth);
    assert.deepEqual(
      (await f.path({ kind: "folder", id: p3.id })).ancestors.map(
        (item) => item.name,
      ),
      ["P1", "P2"],
    );

    const otherSpace = await f.request("/workspaces", "POST", {
      name: "另一个空间",
    });

    assert.equal(otherSpace.status, 200);
    const otherId = otherSpace.body.workspace.id as string;
    const otherFolder = await f.request(
      `/workspaces/${otherId}/folders`,
      "POST",
      { name: "外部文件夹", parentId: null, catalogRevision: 0 },
    );

    assert.equal(otherFolder.status, 200);
    const beforeCrossSpace = await f.currentRevision();
    const crossSpace = await f.move({
      source: { kind: "folder", id: a.id },
      parentId: otherFolder.body.item.id,
      placement: "end",
    });

    assert.ok([400, 404].includes(crossSpace.status));
    assert.ok(
      ["INVALID_DIRECTORY_MOVE", "NOT_FOUND"].includes(errorCode(crossSpace)!),
    );
    assert.equal(await f.refreshRevision(), beforeCrossSpace);
    assert.equal(
      (await f.path({ kind: "folder", id: a.id })).ancestors.length,
      0,
    );

    const memberSpaces = await f.request(
      "/workspaces",
      "GET",
      undefined,
      f.memberCookie(),
    );

    assert.equal(memberSpaces.status, 200);
    const memberWorkspace = memberSpaces.body.workspaces[0].id as string;
    const memberFolder = await f.request(
      `/workspaces/${memberWorkspace}/folders`,
      "POST",
      { name: "他人文件夹", parentId: null, catalogRevision: 0 },
      f.memberCookie(),
    );

    assert.equal(memberFolder.status, 200);
    const beforeCrossUser = await f.currentRevision();
    const crossUser = await f.request(
      `/workspaces/${f.workspaceId}/directory/move`,
      "PUT",
      {
        source: { kind: "folder", id: a.id },
        parentId: memberFolder.body.item.id,
        placement: "end",
        catalogRevision: beforeCrossUser,
      },
    );

    assert.equal(crossUser.status, 404);
    assert.equal(errorCode(crossUser), "NOT_FOUND");
    assert.equal(await f.refreshRevision(), beforeCrossUser);

    // 目标不是直接子项时不得移动；源仍留在根目录。

    const notDirectChild = await f.move({
      source: { kind: "folder", id: a.id },
      parentId: g.id,
      target: { kind: "canvas", id: leafCanvas.id },
      placement: "before",
    });

    assert.equal(notDirectChild.status, 400);
    assert.equal(errorCode(notDirectChild), "INVALID_DIRECTORY_MOVE");
    assert.equal(
      (await f.page()).items.some((item) => item.id === a.id),
      true,
    );
  } finally {
    await f.close();
  }
});

test("旧 0.9.0 画布迁移为根节点，旧置顶映射收藏且旧纯画布接口保持可用", async () => {
  const root = await mkdtemp(join(tmpdir(), "sidebar-directory-upgrade-"));
  const legacyDirectory = join(root, "legacy-migrations");
  const databaseDirectory = join(root, "upgrade");
  let storage: Awaited<ReturnType<typeof nodeStorage>> | undefined;

  const requestFor = (
    current: Awaited<ReturnType<typeof nodeStorage>>,
    cookie = "",
    path: string,
    method = "GET",
    data?: unknown,
  ) =>
    handleApi(
      new Request(`${origin}/api${path}`, {
        method,
        headers: {
          Origin: origin,
          "X-Requested-With": "excalidraw-demo",
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      {
        ...current,
        publicOrigin: origin,
        waitUntil: () => {},
      },
    );

  try {
    await mkdir(join(legacyDirectory, "sqlite"), { recursive: true });
    await mkdir(databaseDirectory, { recursive: true });
    const files = await readdir(resolve("server/db/migrations/sqlite"));

    for (const file of files.filter(
      (entry) =>
        entry.endsWith(".sql") && entry <= "0012_active_canvas_catalog.sql",
    ))
      await cp(
        resolve("server/db/migrations/sqlite", file),
        join(legacyDirectory, "sqlite", file),
      );
    storage = await nodeStorage(databaseDirectory, legacyDirectory);
    const token = "a".repeat(64);
    const hash = await digest(token);
    const cookie = `excalidraw_session=${token}`;
    const workspaceId = "legacy-space";
    const pinnedId = "legacy-canvas-pinned";
    const legacyPositions = new Map([
      ["legacy-canvas-root", 0],
      ["legacy-canvas-pinned", 1],
    ]);

    // 旧库直接用 0.9.0 schema 的列播种；不能借当前注册/画布 API 往旧表写新增列。
    await storage.database.run(
      sql`INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES ('legacy-owner', 'legacy@test', '旧账号', 'admin', 'unused', '2026-01-01')`,
    );
    await storage.database.run(
      sql`INSERT INTO workspaces (id, user_id, name, created_at, updated_at, catalog_revision, deleting, deleted_at) VALUES (${workspaceId}, 'legacy-owner', '我的工作区', '2026-01-01', '2026-01-01', 0, 0, NULL)`,
    );
    await storage.database.run(
      sql`INSERT INTO canvases (id, workspace_id, name, created_at, updated_at, position, pinned) VALUES ('legacy-canvas-root', ${workspaceId}, '旧根画布', '2026-01-01', '2026-01-01', 0, 0), (${pinnedId}, ${workspaceId}, '旧置顶画布', '2026-01-01', '2026-01-01', 1, 1)`,
    );
    await storage.database.run(
      sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${hash}, 'legacy-owner', ${Date.now() + 86400000})`,
    );

    storage.close();
    storage = await nodeStorage(databaseDirectory);
    const legacyCatalog = await requestFor(
      storage,
      cookie,
      `/workspaces/${workspaceId}/canvases`,
    ).then((response) => response.json());
    const directory = await requestFor(
      storage,
      cookie,
      `/workspaces/${workspaceId}/directory`,
    ).then((response) => response.json());

    assert.equal(directory.total, legacyCatalog.canvases.length);
    assert.ok(
      directory.items.every(
        (item: DirectoryNode) =>
          item.kind === "canvas" && item.parentId === null,
      ),
      "旧数据全部成为根画布节点",
    );
    const pinnedNode = directory.items.find(
      (item: DirectoryNode) => item.id === pinnedId,
    )!;

    assert.equal(pinnedNode.favorite, true);
    for (const item of directory.items as DirectoryNode[])
      assert.equal(item.position, legacyPositions.get(item.id));
    const favorites = await requestFor(
      storage,
      cookie,
      `/workspaces/${workspaceId}/favorites`,
    ).then((response) => response.json());

    assert.deepEqual(
      favorites.items.map((item: DirectoryNode) => item.id),
      [pinnedId],
    );
    const afterCatalog = await requestFor(
      storage,
      cookie,
      `/workspaces/${workspaceId}/canvases`,
    ).then((response) => response.json());

    assert.deepEqual(
      afterCatalog.canvases.map((canvas: { id: string }) => canvas.id),
      legacyCatalog.canvases.map((canvas: { id: string }) => canvas.id),
    );
    assert.equal(
      afterCatalog.canvases.find(
        (canvas: { id: string }) => canvas.id === pinnedId,
      ).pinned,
      true,
    );
    const path = await requestFor(
      storage,
      cookie,
      `/workspaces/${workspaceId}/directory/path?kind=canvas&id=${pinnedId}`,
    ).then((response) => response.json());

    assert.equal(path.item.id, pinnedId);
    assert.deepEqual(path.ancestors, []);
    assert.equal(path.pages.length, 1);
  } finally {
    storage?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("目录与收藏接口只对所有者开放，缺失父级不泄露也不改版本", async () => {
  const f = await directoryFixture();

  try {
    const folder = await f.createFolder("私有文件夹");
    const canvas = await f.createCanvas("私有画布", folder.id);
    const memberWorkspace = (await f.memberSpaces()).body.workspaces[0]
      .id as string;
    const before = await f.currentRevision();
    const cases = [
      await f.request(
        `/workspaces/${f.workspaceId}/directory`,
        "GET",
        undefined,
        f.memberCookie(),
      ),
      await f.request(
        `/workspaces/${f.workspaceId}/favorites`,
        "GET",
        undefined,
        f.memberCookie(),
      ),
      await f.request(
        `/workspaces/${f.workspaceId}/directory/path?kind=folder&id=${folder.id}`,
        "GET",
        undefined,
        f.memberCookie(),
      ),
      await f.request(
        `/workspaces/${f.workspaceId}/folders`,
        "POST",
        { name: "越权", parentId: null, catalogRevision: before },
        f.memberCookie(),
      ),
      await f.request(
        `/folders/${folder.id}`,
        "PATCH",
        { name: "越权", catalogRevision: before },
        f.memberCookie(),
      ),
      await f.request(
        `/folders/${folder.id}/summary`,
        "GET",
        undefined,
        f.memberCookie(),
      ),
      await f.request(
        `/folders/${folder.id}`,
        "DELETE",
        { catalogRevision: before },
        f.memberCookie(),
      ),
      await f.request(
        `/workspaces/${f.workspaceId}/directory/move`,
        "PUT",
        {
          source: { kind: "folder", id: folder.id },
          parentId: null,
          placement: "end",
          catalogRevision: before,
        },
        f.memberCookie(),
      ),
      await f.request(
        `/workspaces/${f.workspaceId}/favorites`,
        "PUT",
        {
          source: { kind: "canvas", id: canvas.id },
          favorite: true,
          catalogRevision: before,
        },
        f.memberCookie(),
      ),
      await f.request(`/workspaces/${memberWorkspace}/directory`, "GET"),
    ];

    for (const result of cases) {
      assert.equal(result.status, 404, JSON.stringify(result.body));
      assert.equal(errorCode(result), "NOT_FOUND");
    }

    const missingParent = await f.request(
      `/workspaces/${f.workspaceId}/folders`,
      "POST",
      { name: "缺失父级", parentId: "missing-parent", catalogRevision: before },
    );

    assert.equal(missingParent.status, 404);
    assert.equal(errorCode(missingParent), "NOT_FOUND");
    const missingCanvasParent = await f.request(
      `/workspaces/${f.workspaceId}/canvases`,
      "POST",
      { name: "缺失父级", parentId: "missing-parent", catalogRevision: before },
    );

    assert.equal(missingCanvasParent.status, 404);
    assert.equal(errorCode(missingCanvasParent), "NOT_FOUND");
    assert.equal(await f.refreshRevision(), before);
    assert.equal((await f.page()).total, 2);
  } finally {
    await f.close();
  }
});

test("所有目录写操作使用目录版本 CAS，过期版本不改变树或收藏", async () => {
  const f = await directoryFixture();

  try {
    const folder = await f.createFolder("CAS 文件夹");
    const other = await f.createFolder("CAS 收藏夹");
    const canvas = await f.createCanvas("CAS 画布");
    const stale = await f.currentRevision();

    await f.renameFolder(folder.id, "CAS 文件夹改名");
    assert.equal(await f.currentRevision(), stale + 1);
    await f.favorite({ kind: "folder", id: folder.id });
    await f.favorite({ kind: "folder", id: other.id });
    const fresh = await f.currentRevision();
    const favoritesBefore = ids(await f.favorites());
    const requests = [
      f.request(`/workspaces/${f.workspaceId}/folders`, "POST", {
        name: "过期新建",
        parentId: null,
        catalogRevision: stale,
      }),
      f.request(`/workspaces/${f.workspaceId}/canvases`, "POST", {
        name: "过期画布",
        parentId: null,
        catalogRevision: stale,
      }),
      f.request(`/workspaces/${f.workspaceId}/directory/move`, "PUT", {
        source: { kind: "folder", id: folder.id },
        parentId: other.id,
        placement: "end",
        catalogRevision: stale,
      }),
      f.request(`/workspaces/${f.workspaceId}/favorites`, "PUT", {
        source: { kind: "canvas", id: canvas.id },
        favorite: true,
        catalogRevision: stale,
      }),
      f.request(`/folders/${folder.id}`, "PATCH", {
        name: "过期改名",
        catalogRevision: stale,
      }),
      f.request(`/folders/${folder.id}`, "DELETE", { catalogRevision: stale }),
      f.request(`/workspaces/${f.workspaceId}/favorites/order`, "PUT", {
        source: { kind: "folder", id: other.id },
        target: { kind: "folder", id: folder.id },
        placement: "before",
        catalogRevision: stale,
      }),
    ];
    const results = await Promise.all(requests);

    for (const result of results) {
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.equal(errorCode(result), "CATALOG_CONFLICT");
    }

    assert.equal(await f.refreshRevision(), fresh);
    const root = await f.page();

    assert.equal(root.total, 4);
    assert.equal(
      root.items.some((item) => item.name === "过期新建"),
      false,
    );
    assert.equal(
      root.items.some((item) => item.name === "过期改名"),
      false,
    );
    const folderNode = root.items.find((item) => item.id === folder.id)!;

    assert.equal(folderNode.name, "CAS 文件夹改名");
    assert.equal(folderNode.parentId, null);
    assert.deepEqual(ids(await f.favorites()), favoritesBefore);
  } finally {
    await f.close();
  }
});
