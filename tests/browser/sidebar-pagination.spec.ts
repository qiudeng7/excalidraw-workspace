// 真实 Chromium 运行 Vue 侧栏、目录控制器和编辑器；HTTP API 使用本文件隔离替身。
// 保护布局、分页交互、账号菜单、局部移动与最近画布；不证明数据库查询、权限或真实保存持久化。
// 替身仅提供分页协议及受控延迟/错误；所有滚动、焦点、可见性及列表合并均检查真实界面。
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { CanvasDocument, User } from "../../shared/contracts";
import { test, expect, type WorkspaceFixture } from "./fixtures";

type Read = { space: string; limit: string | null; cursor: string | null };

const canvasRows = (page: Page) =>
  page.locator(".canvas-list [data-canvas-id]");
const canvasRow = (page: Page, index: number) =>
  page.locator(`.canvas-list [data-canvas-id="canvas-${index}"]`);
const scrollArea = (page: Page) => page.locator(".sidebar-scroll");
const accountTrigger = (page: Page) =>
  page.getByRole("button", { name: "账号菜单", exact: true });
const accountMenu = (page: Page) =>
  page.getByRole("menu", { name: "账号菜单", exact: true });

async function openSidebar(page: Page) {
  const trigger = page.getByRole("button", {
    name: "切换工作空间侧边栏",
    exact: true,
  });

  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute("aria-expanded")) === "false")
    await trigger.click();
  await expect(scrollArea(page)).toBeVisible();
}

async function scrollBottom(page: Page) {
  await scrollArea(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
}

// 等两个浏览器绘制周期，让真实 observer/focus 事件有机会执行，不用固定毫秒等待代替完成条件。
async function renderFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolveFrame) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolveFrame()),
        ),
      ),
  );
}

async function directory(
  page: Page,
  workspace: WorkspaceFixture,
  count: number,
  options: { recent?: number; shared?: number } = {},
) {
  const spaces = ["test-space", "second-space"].map((id, index) => ({
    id,
    name: index ? "第二空间" : "测试空间",
    catalogRevision: 0,
    createdAt: "2026-10-22",
    updatedAt: "2026-10-22",
  }));
  const canvases: CanvasDocument[] = Array.from(
    { length: count },
    (_, index) => ({
      id: `canvas-${index}`,
      workspaceId: "test-space",
      name: `分页画布 ${index + 1}`,
      pinned: false,
      position: index,
      revision: 0,
      createdAt: "2026-10-22",
      updatedAt: "2026-10-22",
      scene: { elements: [], appState: {}, files: {} },
    }),
  );
  let revision = 0;
  let user: User = { ...workspace.mock.user };
  let failNextAppend = false;
  let releaseAppend: (() => void) | undefined;
  let appendGate: Promise<void> | undefined;
  let logoutCalls = 0;
  let releaseSave: (() => void) | undefined;
  let saveGate: Promise<void> | undefined;
  const saving: string[] = [];
  const reads: Read[] = [];
  const opened: string[] = [];
  const moves: { id: string; body: unknown }[] = [];
  const navigation = (canvasId: string | null) => ({
    revision: 0,
    lastWorkspaceId: "test-space",
    lastCanvasId: canvasId,
    workspaces: [{ workspaceId: "test-space", lastCanvasId: canvasId }],
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/session") return route.fulfill({ json: { user } });
    if (path === "/api/logout") {
      logoutCalls++;

      return route.fulfill({ json: { ok: true } });
    }

    if (path === "/api/workspaces")
      return route.fulfill({ json: { workspaces: spaces } });
    if (path === "/api/navigation")
      return route.fulfill({
        json: navigation(
          request.method() === "PUT"
            ? request.postDataJSON().canvasId
            : count
              ? `canvas-${options.recent ?? 0}`
              : null,
        ),
      });
    if (path === "/api/shared-canvases")
      return route.fulfill({
        json: {
          canvases: Array.from({ length: options.shared ?? 0 }, (_, index) => ({
            ...canvases[0],
            id: `shared-${index}`,
            name: `共享画布 ${index + 1}`,
            role: "viewer",
          })),
        },
      });
    const listing = path.match(/^\/api\/workspaces\/([^/]+)\/canvases$/);

    if (listing && request.method() === "GET") {
      const space = listing[1]!;
      const cursor = url.searchParams.get("cursor");
      const limit = url.searchParams.get("limit");

      reads.push({ space, limit, cursor });
      if (cursor) {
        if (appendGate) await appendGate;
        if (failNextAppend) {
          failNextAppend = false;

          return route.fulfill({
            status: 503,
            json: {
              error: { code: "TEST_UNAVAILABLE", message: "分页暂不可用" },
            },
          });
        }
      }

      const entries = space === "test-space" ? canvases : [];
      const offset = cursor ? Number(cursor.split(":")[1]) : 0;
      const end = limit ? offset + Number(limit) : entries.length;

      return route.fulfill({
        json: {
          catalogRevision: revision,
          canvases: entries.slice(offset, end),
          total: entries.length,
          nextCursor: end < entries.length ? `${revision}:${end}` : null,
        },
      });
    }

    const move = path.match(/^\/api\/canvases\/([^/]+)\/move$/);

    if (move && request.method() === "PUT") {
      const body = request.postDataJSON();
      const source = canvases.findIndex((canvas) => canvas.id === move[1]);
      const [canvas] = canvases.splice(source, 1);
      const target = canvases.findIndex((entry) => entry.id === body.targetId);

      expect(canvas, "移动源必须是现有画布").toBeDefined();
      expect(target, "移动目标必须是真实相邻画布").toBeGreaterThanOrEqual(0);
      expect(body.catalogRevision).toBe(revision);
      canvases.splice(
        target + (body.placement === "after" ? 1 : 0),
        0,
        canvas!,
      );
      canvases.forEach((entry, index) => {
        entry.position = index;
      });
      moves.push({ id: move[1]!, body });
      revision++;

      return route.fulfill({ json: { catalogRevision: revision } });
    }

    const canvas = canvases.find(
      (entry) => path === `/api/canvases/${entry.id}`,
    );

    if (canvas && request.method() === "PUT") {
      saving.push(canvas.id);
      if (saveGate) await saveGate;
      canvas.scene = request.postDataJSON().scene;
      canvas.revision++;

      return route.fulfill({
        json: { revision: canvas.revision, updatedAt: canvas.updatedAt },
      });
    }

    if (canvas && request.method() === "GET") {
      opened.push(canvas.id);

      return route.fulfill({ json: { canvas } });
    }

    return route.fallback();
  });
  await page.reload();
  await openSidebar(page);
  await expect(page.locator(".canvas-heading .count")).toHaveText(
    String(count),
  );

  return {
    reads,
    opened,
    moves,
    logoutCalls: () => logoutCalls,
    saving,
    saved: (index: number) => canvases[index]!.scene.elements.length,
    holdSave: () => {
      saveGate = new Promise<void>((resolveGate) => {
        releaseSave = resolveGate;
      });
    },
    releaseSave: () => {
      saveGate = undefined;
      releaseSave?.();
    },
    failAppend: () => {
      failNextAppend = true;
    },
    holdAppend: () => {
      appendGate = new Promise<void>((resolveGate) => {
        releaseAppend = resolveGate;
      });
    },
    releaseAppend: () => {
      appendGate = undefined;
      releaseAppend?.();
    },
    changeUser: (id: string) => {
      user = { ...user, id };
    },
  };
}

async function assertLayout(page: Page) {
  const bottom = page.locator(".sidebar-bottom");
  const recycle = bottom.getByRole("button", { name: "回收站", exact: true });
  const settings = bottom.getByRole("button", { name: "设置", exact: true });
  const header = page.locator(".workspace-picker");
  const beforeHeader = (await header.boundingBox())!;
  const beforeBottom = (await bottom.boundingBox())!;

  await expect(bottom).toBeVisible();
  await expect(recycle).toBeInViewport({ ratio: 1 });
  await expect(settings).toBeInViewport({ ratio: 1 });
  await expect(accountTrigger(page)).toBeInViewport({ ratio: 1 });
  const bounds = await scrollArea(page).boundingBox();

  expect(bounds!.y).toBeGreaterThanOrEqual(
    beforeHeader.y + beforeHeader.height - 1,
  );
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(beforeBottom.y + 1);
  const actionBounds = await Promise.all([
    recycle.boundingBox(),
    settings.boundingBox(),
  ]);

  expect(Math.abs(actionBounds[0]!.y - actionBounds[1]!.y)).toBeLessThan(2);
  await scrollBottom(page);
  await renderFrames(page);
  expect((await header.boundingBox())!.y).toBeCloseTo(beforeHeader.y, 0);
  expect((await bottom.boundingBox())!.y).toBeCloseTo(beforeBottom.y, 0);
  expect(beforeBottom.y + beforeBottom.height).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const nestedScrollers = await scrollArea(page).evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>("*")]
      .filter(
        (element) =>
          /^(auto|scroll)$/.test(getComputedStyle(element).overflowY) &&
          element.scrollHeight > element.clientHeight,
      )
      .map((element) => element.className),
  );

  expect(
    nestedScrollers,
    "中部只允许一个滚动区域，共享列表不能嵌套滚动",
  ).toEqual([]);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  for (const theme of ["light", "dark"] as const) {
    for (const count of [0, 1, 30, 31, 300]) {
      test(`${theme} ${viewport.width}×${viewport.height}，${count}张画布时顶部底部固定且中部独立滚动`, async ({
        page,
        workspace,
      }, testInfo) => {
        await page.setViewportSize(viewport);
        await page.context().addCookies([
          {
            name: "workspace-theme",
            value: theme,
            url: new URL(page.url()).origin,
          },
        ]);
        await directory(page, workspace, count, { shared: 14 });
        const shared = page.getByRole("button", {
          name: "与我共享",
          exact: true,
        });

        if ((await shared.getAttribute("aria-expanded")) === "false")
          await shared.click();
        await expect(page.locator(".shared-list a")).toHaveCount(14);
        await assertLayout(page);
        // 真实增长到完整目录，验证大量条目不会把固定底部推出视口。
        while ((await canvasRows(page).count()) < count) {
          const loaded = await canvasRows(page).count();

          await scrollBottom(page);
          await expect
            .poll(() => canvasRows(page).count())
            .toBeGreaterThan(loaded);
        }

        await assertLayout(page);
        if (viewport.width === 390) {
          for (const button of [
            accountTrigger(page),
            page.getByRole("button", { name: "回收站", exact: true }),
            page.getByRole("button", { name: "设置", exact: true }),
          ]) {
            expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(
              44,
            );
          }
        }

        const path = resolve(
          "test-results/browser",
          `sidebar-pagination-${theme}-${viewport.width}x${viewport.height}-${count}.png`,
        );

        await mkdir(resolve("test-results/browser"), { recursive: true });
        await page.screenshot({ path });
        await testInfo.attach("侧栏固定布局", {
          path,
          contentType: "image/png",
        });
      });
    }
  }
}

test("首屏仅取30条，触底请求单飞并追加无重复，末页停止请求", async ({
  page,
  workspace,
}) => {
  const f = await directory(page, workspace, 61);

  await expect(canvasRows(page)).toHaveCount(30);
  expect(f.reads).toHaveLength(1);
  expect(f.reads[0]).toEqual({
    space: "test-space",
    limit: "30",
    cursor: null,
  });
  f.holdAppend();
  await scrollBottom(page);
  await expect.poll(() => f.reads.length).toBe(2);
  await expect(page.getByText("正在加载更多…", { exact: true })).toBeVisible();
  await scrollArea(page).dispatchEvent("scroll");
  await renderFrames(page);
  expect(f.reads).toHaveLength(2);
  // 追加等待期间仍可打开已加载画布。
  await canvasRow(page, 29).locator(".canvas-name").click();
  await expect.poll(() => f.opened.includes("canvas-29")).toBe(true);
  f.releaseAppend();
  await expect(canvasRows(page)).toHaveCount(60);
  await scrollBottom(page);
  await expect(canvasRows(page)).toHaveCount(61);
  await expect(
    page.getByText("已显示全部 61 张画布", { exact: true }),
  ).toBeVisible();
  expect(
    await canvasRows(page).evaluateAll(
      (rows) =>
        new Set(rows.map((row) => row.getAttribute("data-canvas-id"))).size,
    ),
  ).toBe(61);
  const finished = f.reads.length;

  await scrollBottom(page);
  await scrollArea(page).dispatchEvent("scroll");
  await renderFrames(page);
  expect(f.reads).toHaveLength(finished);
});

test("追加失败保留30条和当前编辑器，停止自动重试直到手动重试", async ({
  page,
  workspace,
}) => {
  const f = await directory(page, workspace, 31);

  f.failAppend();
  await scrollBottom(page);
  const retry = page.getByRole("button", {
    name: "加载失败，重试",
    exact: true,
  });

  await expect(retry).toBeVisible();
  await expect(canvasRows(page)).toHaveCount(30);
  await expect(page.locator(".excalidraw")).toHaveCount(1);
  await expect(
    page.locator('[role="tab"][aria-selected="true"]'),
  ).toContainText("分页画布 1");
  const failed = f.reads.length;

  await scrollArea(page).dispatchEvent("scroll");
  await renderFrames(page);
  expect(f.reads).toHaveLength(failed);
  await retry.click();
  await expect(canvasRows(page)).toHaveCount(31);
  await expect(retry).toBeHidden();
});

test("画布折叠暂停触底，展开复用已加载页，按工作空间和账号隔离并跨刷新记住", async ({
  page,
  workspace,
}) => {
  const f = await directory(page, workspace, 60);

  await page.getByRole("button", { name: "折叠画布", exact: true }).click();
  await scrollBottom(page);
  await renderFrames(page);
  expect(f.reads).toHaveLength(1);
  await page.reload();
  await openSidebar(page);
  await expect(
    page.getByRole("button", { name: "展开画布", exact: true }),
  ).toBeVisible();
  await page.locator("#workspace-select").click();
  await page.getByRole("option", { name: "第二空间", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "折叠画布", exact: true }),
  ).toBeVisible();
  await page.locator("#workspace-select").click();
  await page.getByRole("option", { name: "测试空间", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "展开画布", exact: true }),
  ).toBeVisible();
  const beforeExpand = f.reads.length;

  await page.getByRole("button", { name: "展开画布", exact: true }).click();
  await expect(canvasRows(page)).toHaveCount(30);
  expect(f.reads).toHaveLength(beforeExpand);
  await page.getByRole("button", { name: "折叠画布", exact: true }).click();
  f.changeUser("another-user");
  await page.reload();
  await openSidebar(page);
  await expect(
    page.getByRole("button", { name: "折叠画布", exact: true }),
  ).toBeVisible();
});

test("最近画布超过首屏时按ID直接打开并展示当前快捷行，加载到该项后自动去重", async ({
  page,
  workspace,
}) => {
  const f = await directory(page, workspace, 61, { recent: 45 });

  await expect(canvasRows(page)).toHaveCount(30);
  expect(f.reads).toHaveLength(1);
  expect(f.opened).toContain("canvas-45");
  await expect(
    page.locator('[role="tab"][aria-selected="true"]'),
  ).toContainText("分页画布 46");
  await expect(page.locator(".current-canvas-shortcut")).toContainText(
    "当前画布",
  );
  await expect(page.locator(".current-canvas-shortcut")).toContainText(
    "分页画布 46",
  );
  await scrollBottom(page);
  await expect(canvasRows(page)).toHaveCount(60);
  await expect(canvasRow(page, 45)).toHaveCount(1);
  await expect(page.locator(".current-canvas-shortcut")).toHaveCount(0);
  await expect(page.locator(".excalidraw")).toHaveCount(1);
});

test("末项下移先取得下一页真实相邻项，再通过局部移动刷新顺序", async ({
  page,
  workspace,
}) => {
  const f = await directory(page, workspace, 31);

  await expect(canvasRows(page)).toHaveCount(30);
  // 键盘从已加载末项触发，避免浏览器把末项滚入视图后 observer 抢先加载。
  await canvasRow(page, 29)
    .locator(".drag-handle")
    .evaluate((element: HTMLElement) => element.focus({ preventScroll: true }));
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => f.moves.length).toBe(1);
  expect(f.reads.some((read) => read.cursor !== null)).toBe(true);
  expect(f.moves[0]).toEqual({
    id: "canvas-29",
    body: { targetId: "canvas-30", placement: "after", catalogRevision: 0 },
  });
  await expect(canvasRows(page).locator(".canvas-name")).toHaveText([
    ...Array.from({ length: 29 }, (_, index) => `分页画布 ${index + 1}`),
    "分页画布 31",
    "分页画布 30",
  ]);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`${viewport.width}px账号菜单向上展示完整长名称邮箱，键盘和点击关闭后恢复焦点`, async ({
    page,
    workspace,
  }) => {
    workspace.mock.user.name = "名称很长的测试账号".repeat(8);
    workspace.mock.user.email = `${"long-address-".repeat(12)}@example.test`;
    await page.setViewportSize(viewport);
    await directory(page, workspace, 1);
    const trigger = accountTrigger(page);

    await expect(trigger).toContainText(workspace.mock.user.name);
    await expect(trigger.locator(".avatar")).toBeVisible();
    expect(
      await trigger.evaluate(
        (element, name) =>
          [element, ...element.querySelectorAll("[title]")].some(
            (node) => node.getAttribute("title") === name,
          ),
        workspace.mock.user.name,
      ),
    ).toBe(true);
    await expect(page.locator(".sidebar-bottom")).not.toContainText(
      workspace.mock.user.email,
    );
    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = accountMenu(page);

    await expect(menu).toBeVisible();
    await expect(menu).toContainText(workspace.mock.user.name);
    await expect(menu).toContainText(workspace.mock.user.email);
    const menuBox = (await menu.boundingBox())!;
    const triggerBox = (await trigger.boundingBox())!;

    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(triggerBox.y + 1);
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(
      await menu.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("ArrowDown");
    await expect(
      menu.getByRole("menuitem", { name: "退出登录", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.locator(".canvas-heading").click();
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}

test("账号菜单退出等待当前和后台画布的待保存内容完成", async ({
  page,
  workspace,
}) => {
  const f = await directory(page, workspace, 2);

  f.holdSave();
  try {
    for (const index of [0, 1]) {
      if (index) await canvasRow(page, index).locator(".canvas-name").click();
      await page.getByRole("button", { name: "矩形", exact: true }).click();
      const bounds = (await page.locator(".excalidraw").boundingBox())!;
      const x = bounds.x + 350;
      const y = bounds.y + 250;

      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 100, y + 80);
      await page.mouse.up();
    }

    await accountTrigger(page).click();
    await accountMenu(page)
      .getByRole("menuitem", { name: "退出登录", exact: true })
      .click();
    await expect.poll(() => f.saving.length).toBeGreaterThan(0);
    await renderFrames(page);
    expect(f.logoutCalls()).toBe(0);
    f.releaseSave();
    await expect.poll(f.logoutCalls).toBe(1);
    expect(f.saved(0)).toBe(1);
    expect(f.saved(1)).toBe(1);
    await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
  } finally {
    f.releaseSave();
  }
});

test.describe("触屏账号入口", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("轻触账号行打开菜单并可轻触退出登录", async ({ page, workspace }) => {
    const f = await directory(page, workspace, 1);
    const bounds = (await accountTrigger(page).boundingBox())!;

    await page.touchscreen.tap(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    const logout = accountMenu(page).getByRole("menuitem", {
      name: "退出登录",
      exact: true,
    });

    await expect(logout).toBeVisible();
    const itemBounds = (await logout.boundingBox())!;

    expect(itemBounds.height).toBeGreaterThanOrEqual(44);
    await page.touchscreen.tap(
      itemBounds.x + itemBounds.width / 2,
      itemBounds.y + itemBounds.height / 2,
    );
    await expect.poll(f.logoutCalls).toBe(1);
    await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
  });
});
