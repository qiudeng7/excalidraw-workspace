// 真实 H3、迁移和临时 SQLite/文件对象验证工作空间搜索的权限、范围与分页。
// 验证 legacy 快照与协作房间都按权威内容匹配；preparing 只记入 skipped，不建房间、不卡分页。
// 不覆盖浏览器入口、真实 D1/R2 或云端部署。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
import { nodeStorage } from "./support/storage";
import { handleApi } from "./support/api";
import { canvases, collaborationRooms } from "../../server/db/schema";

interface SearchMatch {
  kind: "text" | "frame";
  elementId: string;
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

interface SearchGroup {
  canvas: { id: string; name: string; workspaceId: string };
  titleMatched: boolean;
  matches: SearchMatch[];
  folderPath?: string;
}

interface SearchPage {
  groups: SearchGroup[];
  nextCursor: string | null;
  catalogRevision: number;
  validatedCurrentCanvasId?: string;
  skipped: { canvasId: string; code: string }[];
}

interface SearchResult {
  status: number;
  body: SearchPage & { error?: { code: string } };
}

const text = (
  id: string,
  originalText: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  angle: 0,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  text: originalText,
  originalText,
  ...extra,
});
const frame = (id: string, name?: string) => ({
  id,
  type: "frame",
  x: 200,
  y: 0,
  width: 300,
  height: 200,
  angle: 0,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  ...(name === undefined ? {} : { name }),
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "workspace-search-"));
  const storage = await nodeStorage(directory);
  const origin = "https://workspace-search.test";
  const pending: Promise<unknown>[] = [];
  let cookie = "";

  const request = async (
    path: string,
    method = "GET",
    data?: unknown,
    actor = cookie,
  ) => {
    const response = await handleApi(
      new Request(`${origin}/api${path}`, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Requested-With": "excalidraw-demo",
          ...(actor ? { Cookie: actor } : {}),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      {
        database: storage.database,
        blob: storage.blob,
        publicOrigin: origin,
        waitUntil: (task) => pending.push(task),
      },
    );

    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
    };
  };

  const setup = await request("/setup", "POST", {
    email: "search-owner@example.test",
    password: "WorkspaceSearchPassword123!",
  });

  assert.equal(setup.status, 200);
  cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const spaces = await request("/workspaces");
  const workspaceId = spaces.body.workspaces[0].id as string;
  const catalog = async () =>
    (await request(`/workspaces/${workspaceId}/canvases`)).body as {
      canvases: { id: string; name: string; revision: number }[];
      catalogRevision: number;
    };
  const createCanvas = async (name: string) => {
    const result = await request(
      `/workspaces/${workspaceId}/canvases`,
      "POST",
      { name },
    );

    assert.equal(result.status, 200);

    return result.body.canvas.id as string;
  };
  const saveScene = async (id: string, elements: unknown[]) => {
    const current = (await catalog()).canvases.find(
      (canvas) => canvas.id === id,
    )!.revision;
    const result = await request(`/canvases/${id}`, "PUT", {
      revision: current,
      scene: { elements, appState: {}, files: {} },
      textFormatVersion: 3,
    });

    assert.equal(result.status, 200, JSON.stringify(result.body));

    return result.body;
  };
  const search = async (
    query: string,
    cursor?: string,
    currentCanvasId?: string,
  ): Promise<SearchResult> => {
    const params = new URLSearchParams({ q: query });

    if (cursor) params.set("cursor", cursor);
    if (currentCanvasId) params.set("currentCanvasId", currentCanvasId);
    const result = await request(`/workspaces/${workspaceId}/search?${params}`);

    return { status: result.status, body: result.body as SearchPage };
  };

  return {
    ...storage,
    request,
    workspaceId,
    catalog,
    createCanvas,
    saveScene,
    search,
    async close() {
      await Promise.all(pending);
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const matchesOf = (page: SearchPage, elementId: string) =>
  page.groups.flatMap((group) =>
    group.matches.filter((match) => match.elementId === elementId),
  );

test("legacy 画布按正文、Frame 已存名称与标题命中，文件夹名与删除元素不参与", async () => {
  const f = await fixture();

  try {
    const before = await f.catalog();
    const canvasId = before.canvases[0]!.id;

    await f.request(`/canvases/${canvasId}`, "PATCH", { name: "季度计划" });
    await f.saveScene(canvasId, [
      text("t-plan", "重庆 补贴 政策补贴"),
      text("t-plain", "Quarterly Plan"),
      text("t-gone", "已删词条", { isDeleted: true }),
      frame("f-named", "阶段一"),
      frame("f-default"),
    ]);
    const folder = await f.request(
      `/workspaces/${f.workspaceId}/folders`,
      "POST",
      {
        name: "补贴文件夹",
        parentId: null,
        catalogRevision: (await f.catalog()).catalogRevision,
      },
    );

    assert.equal(folder.status, 200, JSON.stringify(folder.body));

    const byTitle = await f.search("季度");

    assert.equal(byTitle.status, 200);
    assert.equal(byTitle.body.groups.length, 1);
    assert.equal(byTitle.body.groups[0]!.canvas.id, canvasId);
    assert.equal(byTitle.body.groups[0]!.canvas.name, "季度计划");
    assert.equal(byTitle.body.groups[0]!.titleMatched, true);

    const byBody = await f.search("补贴");
    const match = matchesOf(byBody.body, "t-plan");

    // 每元素一条命中；片段内的 UTF-16 下标正好切出查询词。
    assert.equal(match.length, 1);
    assert.equal(match[0]!.kind, "text");
    assert.equal(
      match[0]!.snippet.slice(match[0]!.matchStart, match[0]!.matchEnd),
      "补贴",
    );
    assert.equal(byBody.body.groups[0]!.titleMatched, false);

    const byCase = await f.search("quarterly");

    assert.equal(byCase.status, 200);
    assert.equal(matchesOf(byCase.body, "t-plain").length, 1);

    const byFrame = await f.search("阶段一");

    assert.equal(byFrame.status, 200);
    assert.deepEqual(
      byFrame.body.groups.flatMap((group) =>
        group.matches.map((item) => [item.kind, item.elementId]),
      ),
      [["frame", "f-named"]],
    );

    const deleted = await f.search("已删词条");

    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body.groups, []);

    const folderName = await f.search("补贴文件夹");

    assert.equal(folderName.status, 200);
    assert.deepEqual(folderName.body.groups, []);

    const defaultFrame = await f.search("frame");

    assert.equal(defaultFrame.status, 200);
    assert.deepEqual(
      defaultFrame.body.groups.flatMap((group) => group.matches),
      [],
    );
  } finally {
    await f.close();
  }
});

test("只允许所有者搜索自己的空间，回收画布不参与且当前画布需服务端确认", async () => {
  const f = await fixture();

  try {
    const canvasId = (await f.catalog()).canvases[0]!.id;

    await f.saveScene(canvasId, [text("t-own", "自有词条")]);
    const other = await f.request("/register", "POST", {
      email: "search-other@example.test",
      password: "WorkspaceSearchOther123!",
    });

    assert.equal(other.status, 200);
    const otherCookie = other.headers.get("set-cookie")!.split(";")[0]!;

    // 其他账号不能搜索这个空间。
    assert.equal(
      (
        await f.request(
          `/workspaces/${f.workspaceId}/search?q=${encodeURIComponent("自有")}`,
          "GET",
          undefined,
          otherCookie,
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.search("自有词条", undefined, canvasId)).body
        .validatedCurrentCanvasId,
      canvasId,
    );
    assert.equal(
      (await f.search("自有词条", undefined, "not-my-canvas")).body
        .validatedCurrentCanvasId,
      undefined,
    );

    // 其他账号自己的画布不能被确认为当前画布。
    const otherWorkspace = (
      await f.request("/workspaces", "GET", undefined, otherCookie)
    ).body.workspaces[0].id as string;
    const otherCanvas = (
      await f.request(
        `/workspaces/${otherWorkspace}/canvases`,
        "GET",
        undefined,
        otherCookie,
      )
    ).body.canvases[0].id as string;

    assert.equal(
      (await f.search("自有词条", undefined, otherCanvas)).body
        .validatedCurrentCanvasId,
      undefined,
    );

    const recycled = await f.createCanvas("待回收画布");

    await f.saveScene(recycled, [text("t-recycled", "回收词条")]);
    assert.equal((await f.search("回收词条")).body.groups.length, 1);
    const removal = await f.request(`/canvases/${recycled}`, "DELETE", {});

    assert.equal(removal.status, 200, JSON.stringify(removal.body));
    assert.deepEqual((await f.search("回收词条")).body.groups, []);
  } finally {
    await f.close();
  }
});

test("空命中页仍返回续游标，分页遍历不重不漏，目录变化拒绝旧游标", async () => {
  const f = await fixture();

  try {
    for (let index = 0; index < 22; index++)
      await f.createCanvas(`共同画布 ${index}`);

    const ids = (await f.catalog()).canvases.map((canvas) => canvas.id);
    const ordered = [...ids].sort();
    const unique = ordered[20]!;

    for (const [index, id] of ids.entries())
      await f.saveScene(id, [
        text(`t-${index}`, `共同关键词 ${index}`),
        ...(id === unique ? [text("t-unique", "独有词条")] : []),
      ]);

    const first = await f.search("独有词条");

    assert.equal(first.status, 200);
    assert.deepEqual(first.body.groups, []);
    assert.equal(typeof first.body.nextCursor, "string");

    const second = await f.search("独有词条", first.body.nextCursor!);

    assert.deepEqual(second.body.groups, []);
    assert.equal(typeof second.body.nextCursor, "string");

    const third = await f.search("独有词条", second.body.nextCursor!);

    assert.equal(third.body.groups.length, 1);
    assert.equal(third.body.groups[0]!.canvas.id, unique);
    assert.equal(third.body.nextCursor, null);

    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page++) {
      const result = await f.search("共同关键词", cursor);

      assert.equal(result.status, 200);
      assert.equal(result.body.catalogRevision, (await f.catalog()).catalogRevision);
      for (const group of result.body.groups) seen.push(group.canvas.id);
      cursor = result.body.nextCursor ?? undefined;
      if (!cursor) break;
    }

    assert.equal(seen.length, 23);
    assert.equal(new Set(seen).size, 23);
    for (const id of ids) assert.ok(seen.includes(id));

    const stale = await f.search("共同关键词");

    assert.equal(typeof stale.body.nextCursor, "string");
    await f.createCanvas("新建打断游标");
    const rejected = await f.search("共同关键词", stale.body.nextCursor!);

    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error!.code, "SEARCH_CATALOG_CHANGED");
    assert.equal((await f.search("共同关键词", "not-a-cursor")).status, 400);
    assert.equal((await f.search("")).status, 400);
    assert.equal((await f.search("x".repeat(65))).status, 400);
  } finally {
    await f.close();
  }
});

test("preparing 画布只记 skipped，不推进迁移，也不卡住本页与后续页", async () => {
  const f = await fixture();

  try {
    for (let index = 0; index < 12; index++)
      await f.createCanvas(`准备画布 ${index}`);

    const ids = (await f.catalog()).canvases.map((canvas) => canvas.id);

    for (const [index, id] of ids.entries())
      await f.saveScene(id, [text(`t-${index}`, `准备词条 ${index}`)]);

    const ordered = (
      await f.database
        .select({ id: canvases.id })
        .from(canvases)
        .orderBy(asc(canvases.id))
    ).map((row) => row.id);
    const blocked = ordered.slice(0, 10);

    await f.database
      .update(canvases)
      .set({ syncMode: "preparing" })
      .where(inArray(canvases.id, blocked));

    const first = await f.search("准备词条");

    assert.equal(first.status, 200);
    assert.deepEqual(first.body.groups, []);
    assert.deepEqual(
      first.body.skipped.map((item) => item.canvasId).sort(),
      [...blocked].sort(),
    );
    for (const item of first.body.skipped)
      assert.equal(item.code, "SEARCH_SCENE_NOT_READY");
    assert.equal(typeof first.body.nextCursor, "string");
    // 搜索不推进迁移：没有生成协作房间。
    assert.deepEqual(await f.database.select().from(collaborationRooms), []);

    const second = await f.search("准备词条", first.body.nextCursor!);

    assert.equal(second.status, 200);
    assert.equal(second.body.skipped.length, 0);
    assert.equal(second.body.groups.length, 3);

    const restored = await f.database
      .update(canvases)
      .set({ syncMode: "legacy" })
      .where(eq(canvases.id, blocked[0]!))
      .returning({ id: canvases.id });

    assert.equal(restored.length, 1);
  } finally {
    await f.close();
  }
});

test("协作画布按房间正文命中旧快照之外的文字，读取不依赖图片对象", async () => {
  const f = await fixture();

  try {
    const canvasId = await f.createCanvas("协作搜索画布");

    await f.saveScene(canvasId, [
      text("t-legacy", "旧快照文字"),
      text("t-keep", "保留文字"),
    ]);
    const published = await f.request(
      `/canvases/${canvasId}/collaboration/versions`,
      "POST",
      { id: "v1", label: "初版" },
    );

    assert.equal(published.status, 200, JSON.stringify(published.body));
    const view = await f.request(`/canvases/${canvasId}/collaboration/view`);

    assert.equal(view.status, 200);
    const current = view.body as { epoch: string; seq: number };
    const update = await f.request(
      `/canvases/${canvasId}/collaboration/update`,
      "POST",
      {
        protocolVersion: 1,
        epoch: current.epoch,
        clientId: "client-search-room",
        clientSeq: 1,
        opId: "op-search-room",
        baseSeq: current.seq,
        elements: [text("t-legacy", "协作正文", { version: 2, versionNonce: 2 })],
      },
    );

    assert.equal(update.status, 200, JSON.stringify(update.body));

    const fresh = await f.search("协作正文");

    assert.equal(fresh.status, 200);
    assert.deepEqual(
      fresh.body.groups.flatMap((group) =>
        group.matches.map((item) => [group.canvas.id, item.elementId]),
      ),
      [[canvasId, "t-legacy"]],
    );
    // 旧快照的同元素文字已被房间合并覆盖。
    assert.deepEqual((await f.search("旧快照文字")).body.groups, []);
    // 响应只含片段，不含图片数据或场景几何；图片对象不参与搜索读取。
    const payload = JSON.stringify(fresh.body);

    assert.equal(payload.includes("data:"), false);
    assert.equal(payload.includes("objectKey"), false);
    assert.equal(payload.includes("fileId"), false);
    assert.equal((await f.search("保留文字")).body.groups.length, 1);
  } finally {
    await f.close();
  }
});
