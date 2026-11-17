// 工作空间搜索控制器：查询代次、迟到响应、授权后的本地整组覆盖、skip 不中止后续页。
// 真实控制器 src/composables/use-workspace-search.ts；搜索端口、场景与上下文为替身。
// 不验证 HTTP 契约、真实编辑器或浏览器交互（分别由 integration 与 browser 套件覆盖）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectScope, ref } from "vue";
import { useWorkspaceSearch } from "../../src/composables/use-workspace-search";
import { ApiError } from "../../src/lib/api";
import type { EditorSearchScene } from "../../src/lib/editor";
import type {
  CanvasSearchGroup,
  SearchPage,
  SearchSkippedCanvas,
} from "../../shared/workspace-search";

const canvas = { id: "c1", name: "当前画布", workspaceId: "w1" };
const other = { id: "c2", name: "另一画布", workspaceId: "w1" };

const group = (
  ref_: { id: string; name: string; workspaceId: string },
  elementId: string,
): CanvasSearchGroup => ({
  canvas: ref_,
  titleMatched: false,
  matches: [
    {
      kind: "text",
      elementId,
      snippet: `片段 ${elementId}`,
      matchStart: 3,
      matchEnd: 5,
    },
  ],
});
const page = (value: Partial<SearchPage> = {}): SearchPage => ({
  groups: [],
  nextCursor: null,
  catalogRevision: 0,
  skipped: [],
  ...value,
});
const scene = (elements: unknown[], canvasId = canvas.id): EditorSearchScene =>
  ({ canvasId, elements }) as EditorSearchScene;
const textElement = (id: string, value: string) => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  angle: 0,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  text: value,
  originalText: value,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });

  return { promise, resolve, reject };
};
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (assertion: () => void, timeout = 2000) => {
  const deadline = Date.now() + timeout;

  for (;;) {
    try {
      assertion();

      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await wait(10);
    }
  }
};

interface SearchCall {
  workspaceId: string;
  query: string;
  cursor?: string;
  currentCanvasId?: string;
  signal?: AbortSignal;
}

interface SearchContext {
  ownerId: string;
  workspaceId: string;
  canvas?: typeof canvas;
}

const harness = (
  options: {
    search: (call: SearchCall) => Promise<SearchPage>;
    context?: () => SearchContext;
    readScene?: () => EditorSearchScene | undefined;
  } = {
    search: async () => page(),
  },
) => {
  const context =
    options.context ?? (() => ({ ownerId: "u1", workspaceId: "w1", canvas }));
  const calls: SearchCall[] = [];
  const scope = effectScope(true);
  const controller = scope.run(() =>
    useWorkspaceSearch({
      context,
      readScene: options.readScene ?? (() => scene([])),
      search: (workspaceId, request) => {
        const call = { workspaceId, ...request };

        calls.push(call);

        return options.search(call);
      },
    }),
  )!;

  return {
    controller,
    calls,
    stop() {
      scope.stop();
    },
  };
};

test("迟到的上一查询响应不会覆盖当前查询结果", async () => {
  const first = deferred<SearchPage>();
  const second = deferred<SearchPage>();
  let calls = 0;
  const f = harness({
    search: () => (calls++ === 0 ? first.promise : second.promise),
  });

  try {
    f.controller.show();
    f.controller.setQuery("甲");
    await waitFor(() => assert.equal(f.calls.length, 1));
    assert.equal(f.calls[0]!.query, "甲");
    assert.equal(f.calls[0]!.signal?.aborted, false);

    f.controller.setQuery("乙");
    await waitFor(() => assert.equal(f.calls.length, 2));
    // 新查询开始前中止旧请求。
    assert.equal(f.calls[0]!.signal?.aborted, true);

    second.resolve(page({ groups: [group(other, "local-2")] }));
    await waitFor(() =>
      assert.deepEqual(
        f.controller.groups.value.map((item) => item.canvas.id),
        ["c2"],
      ),
    );
    first.resolve(page({ groups: [group(other, "late-1")] }));
    await wait(60);
    assert.deepEqual(
      f.controller.groups.value.map((item) => item.canvas.id),
      ["c2"],
    );
    assert.equal(f.controller.loading.value, false);
    assert.equal(f.controller.complete.value, true);
  } finally {
    f.stop();
  }
});

test("服务端确认当前画布后，本地无命中整组替换且后续页不能复活旧命中", async () => {
  const stale: SearchPage = page({
    groups: [group(canvas, "server-stale")],
    nextCursor: "page-2",
    validatedCurrentCanvasId: canvas.id,
  });
  const repeated: SearchPage = page({
    groups: [group(canvas, "server-stale")],
    nextCursor: null,
    validatedCurrentCanvasId: canvas.id,
  });
  const pages = [stale, repeated];
  const f = harness({
    search: async () => pages.shift()!,
    readScene: () => scene([]),
  });

  try {
    f.controller.show();
    f.controller.setQuery("本地");
    await waitFor(() => assert.equal(f.controller.complete.value, true));
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1]!.cursor, "page-2");
    // 授权成立但本地场景没有命中：整组删除，后续页重复的云端旧命中也不复活。
    assert.deepEqual(f.controller.groups.value, []);
    assert.equal(f.controller.error.value, "");
  } finally {
    f.stop();
  }
});

test("本地命中替换授权画布的服务端组，未授权时保留服务端结果", async () => {
  const authorized = harness({
    search: async () =>
      page({
        groups: [group(canvas, "server-stale")],
        validatedCurrentCanvasId: canvas.id,
      }),
    readScene: () => scene([textElement("local-1", "本地文字")]),
  });

  try {
    authorized.controller.show();
    authorized.controller.setQuery("本地");
    await waitFor(() =>
      assert.equal(authorized.controller.complete.value, true),
    );
    assert.deepEqual(
      authorized.controller.groups.value.flatMap((item) =>
        item.matches.map((match) => ["text", match.elementId]),
      ),
      [["text", "local-1"]],
    );
  } finally {
    authorized.stop();
  }

  const unauthorized = harness({
    search: async () => page({ groups: [group(canvas, "server-stale")] }),
    readScene: () => scene([]),
  });

  try {
    unauthorized.controller.show();
    unauthorized.controller.setQuery("本地");
    await waitFor(() =>
      assert.equal(unauthorized.controller.complete.value, true),
    );
    // 没有 validatedCurrentCanvasId 时不展示本地结果，也不静默丢弃服务端命中。
    assert.deepEqual(
      unauthorized.controller.groups.value.flatMap((item) =>
        item.matches.map((match) => match.elementId),
      ),
      ["server-stale"],
    );
  } finally {
    unauthorized.stop();
  }
});

test("单画布 skip 只记入提示，不中止同页与后续页", async () => {
  const skipped: SearchSkippedCanvas = {
    canvasId: "c9",
    code: "SEARCH_SCENE_NOT_READY",
  };
  const pages = [
    page({ nextCursor: "page-2", skipped: [skipped] }),
    page({ groups: [group(other, "local-2")] }),
  ];
  const f = harness({ search: async () => pages.shift()! });

  try {
    f.controller.show();
    f.controller.setQuery("准备");
    await waitFor(() => assert.equal(f.controller.complete.value, true));
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.controller.skipped.value, ["c9"]);
    assert.deepEqual(
      f.controller.groups.value.map((item) => item.canvas.id),
      ["c2"],
    );
    assert.equal(f.controller.error.value, "");
  } finally {
    f.stop();
  }
});

test("页级错误保留已加载结果并可重试，目录版本变化只自动重启一次", async () => {
  const failed = harness({
    search: async () => {
      throw new ApiError(503, "SEARCH_UNAVAILABLE", "搜索暂时不可用");
    },
  });

  try {
    failed.controller.show();
    failed.controller.setQuery("失败");
    await waitFor(() =>
      assert.equal(failed.controller.error.value, "搜索暂时不可用"),
    );
    assert.equal(failed.controller.loading.value, false);
    assert.equal(failed.controller.complete.value, false);
    assert.equal(failed.calls.length, 1);
  } finally {
    failed.stop();
  }

  let attempts = 0;
  const restarted = harness({
    search: async () => {
      attempts++;
      if (attempts === 1)
        throw new ApiError(409, "SEARCH_CATALOG_CHANGED", "目录已变化");

      return page({ groups: [group(other, "local-2")] });
    },
  });

  try {
    restarted.controller.show();
    restarted.controller.setQuery("重启");
    await waitFor(() =>
      assert.equal(restarted.controller.complete.value, true),
    );
    // 目录变化自动从头重搜一次，不把旧结果和新结果混在一起。
    assert.equal(attempts, 2);
    assert.equal(restarted.calls[1]!.cursor, undefined);
    assert.deepEqual(
      restarted.controller.groups.value.map((item) => item.canvas.id),
      ["c2"],
    );
  } finally {
    restarted.stop();
  }
});

test("切换工作空间会关闭搜索并丢弃在途响应", async () => {
  const pending = deferred<SearchPage>();
  const context = ref({ ownerId: "u1", workspaceId: "w1", canvas });
  const f = harness({
    search: () => pending.promise,
    context: () => ({
      ownerId: context.value.ownerId,
      workspaceId: context.value.workspaceId,
      canvas: context.value.canvas,
    }),
  });

  try {
    f.controller.show();
    f.controller.setQuery("跨空间");
    await waitFor(() => assert.equal(f.calls.length, 1));
    context.value = { ownerId: "u1", workspaceId: "w2", canvas };
    await wait(30);
    assert.equal(f.controller.open.value, false);
    assert.equal(f.controller.query.value, "");
    assert.deepEqual(f.controller.groups.value, []);
    pending.resolve(page({ groups: [group(other, "late-2")] }));
    await wait(60);
    assert.deepEqual(f.controller.groups.value, []);
    assert.equal(f.calls[0]!.signal?.aborted, true);
  } finally {
    f.stop();
  }
});
