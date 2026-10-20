// 真实浏览器侧栏交互，API 全部使用隔离替身；不证明账号同步或数据库持久化。
// 验证菜单目标、键盘/触屏入口、视口边界与失败后目录；后端另由 integration 证明。
// 长按时序用合成 PointerEvent；拖柄排除用 Chromium CDP 浏览器触摸输入，均非真机验证。
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { readFileSync } from "node:fs";

// 从根包独立读取需求的权威版本，避免与产品配置共享错误来源。
const packageVersion = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version as string;

const pauseGestureClock = async (page: Page) => {
  // install 本身仍推进实时时钟；先暂停，499/500ms 边界才不受断言耗时影响。
  await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2030-01-01T00:00:01Z"));
};

const directory = async (page: Page) => {
  let revision = 0;
  let mode: "ok" | "error" | "conflict" = "ok";
  let reads = 0;
  const writes: unknown[] = [];
  const canvases = ["test-canvas", "second", "third"].map((id, position) => ({
    id,
    workspaceId: "test-space",
    name: ["测试画布", "第二画布", "第三画布"][position]!,
    pinned: false,
    position,
    revision: 0,
    createdAt: "2026-10-12",
    updatedAt: "2026-10-12",
    scene: { elements: [], appState: {}, files: {} },
  }));
  const catalog = () => ({
    catalogRevision: revision,
    canvases: [...canvases].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || a.position - b.position,
    ),
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/workspaces/test-space/canvases") {
      reads++;

      return route.fulfill({ json: catalog() });
    }

    if (
      path === "/api/workspaces/test-space/canvas-order" &&
      request.method() === "PUT"
    ) {
      const body = request.postDataJSON();

      writes.push(body);
      expect(body.catalogRevision).toBe(revision);
      if (mode !== "ok") {
        return route.fulfill({
          status: mode === "error" ? 503 : 409,
          json: { error: { code: "CATALOG_CONFLICT", message: "排序未保存" } },
        });
      }

      for (const pinned of [true, false]) {
        const slots = canvases
          .filter((canvas) => canvas.pinned === pinned)
          .map((canvas) => canvas.position)
          .sort((a, b) => a - b);
        const group = (body.canvasIds as string[])
          .map((id) => canvases.find((canvas) => canvas.id === id)!)
          .filter((canvas) => canvas.pinned === pinned);

        group.forEach((canvas, index) => {
          canvas.position = slots[index]!;
        });
      }

      revision++;

      return route.fulfill({ json: catalog() });
    }

    const target = canvases.find(
      (canvas) => path === `/api/canvases/${canvas.id}/pin`,
    );

    if (target && request.method() === "PUT") {
      const body = request.postDataJSON();

      writes.push(body);
      expect(body.catalogRevision).toBe(revision);
      if (mode !== "ok") {
        return route.fulfill({
          status: mode === "error" ? 503 : 409,
          json: { error: { code: "CATALOG_CONFLICT", message: "置顶未保存" } },
        });
      }

      target.pinned = body.pinned;
      revision++;

      return route.fulfill({ json: catalog() });
    }

    const opened = canvases.find(
      (canvas) => path === `/api/canvases/${canvas.id}`,
    );

    if (opened && request.method() === "GET") {
      return route.fulfill({ json: { canvas: opened } });
    }

    if (path === "/api/navigation" && request.method() === "PUT") {
      return route.fulfill({
        json: {
          revision: 1,
          lastWorkspaceId: "test-space",
          lastCanvasId: request.postDataJSON().canvasId,
          workspaces: [],
        },
      });
    }

    return route.fallback();
  });
  await page.reload();
  const sidebarToggle = page.getByRole("button", {
    name: "切换工作空间侧边栏",
  });

  await expect(sidebarToggle).toBeVisible();
  if ((await sidebarToggle.getAttribute("aria-expanded")) === "false") {
    await sidebarToggle.click();
  }

  await expect(page.locator(".canvas-name")).toHaveCount(3);

  return {
    writes,
    reads: () => reads,
    fail: (value: typeof mode) => {
      mode = value;
    },
  };
};
const row = (page: Page, id = "second") =>
  page.locator(`[data-canvas-id="${id}"] .canvas-name`);
const menu = (page: Page) =>
  page.getByRole("menu", { name: "画布 第二画布 的操作", exact: true });
const names = (page: Page) => page.locator("[data-canvas-id] .canvas-name");

test("右键非当前画布只打开目标菜单，置顶和取消恢复原顺序且没有旧行尾入口", async ({
  page,
  workspace: _workspace,
}, testInfo) => {
  const f = await directory(page);

  await expect(page.locator("[data-canvas-id] summary")).toHaveCount(0);
  await row(page).click({ button: "right" });
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "test-canvas")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await menu(page).getByRole("menuitem", { name: "置顶", exact: true }).click();
  await expect(names(page)).toHaveText(["第二画布", "测试画布", "第三画布"]);
  await expect(row(page, "test-canvas")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await row(page).click({ button: "right" });
  await menu(page).waitFor({ state: "visible" });
  const screenshot = testInfo.outputPath("sidebar-pinned-context-menu.png");

  await page.screenshot({ path: screenshot });
  await testInfo.attach("侧栏置顶菜单与版本仓库入口", {
    path: screenshot,
    contentType: "image/png",
  });
  await menu(page)
    .getByRole("menuitem", { name: "取消置顶", exact: true })
    .click();
  await expect(names(page)).toHaveText(["测试画布", "第二画布", "第三画布"]);
  expect(f.writes).toEqual([
    { pinned: true, catalogRevision: 0 },
    { pinned: false, catalogRevision: 1 },
  ]);
});

test("菜单上移按组排序，失败回读恢复顺序，置顶组边界不可上下跨组", async ({
  page,
  workspace: _workspace,
}) => {
  const f = await directory(page);

  f.fail("error");
  await row(page).click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "上移", exact: true }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(names(page)).toHaveText(["测试画布", "第二画布", "第三画布"]);
  expect(f.writes).toEqual([
    { canvasIds: ["second", "test-canvas", "third"], catalogRevision: 0 },
  ]);
  f.fail("ok");
  await row(page).click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "上移", exact: true }).click();
  await expect(names(page)).toHaveText(["第二画布", "测试画布", "第三画布"]);
  await row(page).click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "置顶", exact: true }).click();
  await row(page).click({ button: "right" });
  await expect(
    menu(page).getByRole("menuitem", { name: "上移", exact: true }),
  ).toBeDisabled();
  await expect(
    menu(page).getByRole("menuitem", { name: "下移", exact: true }),
  ).toBeDisabled();
});

test("拖动经过同组目标后在另一组松手不得提交残留排序目标", async ({
  page,
  workspace: _workspace,
}) => {
  const f = await directory(page);

  await row(page).click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "置顶", exact: true }).click();
  await expect(names(page)).toHaveText(["第二画布", "测试画布", "第三画布"]);
  const start = (await page
    .locator('[data-canvas-id="third"] .drag-handle')
    .boundingBox())!;
  const sameGroup = (await row(page, "test-canvas").boundingBox())!;
  const otherGroup = (await row(page).boundingBox())!;
  const count = f.writes.length;

  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    sameGroup.x + sameGroup.width / 2,
    sameGroup.y + sameGroup.height / 2,
    { steps: 8 },
  );
  await page.mouse.move(
    otherGroup.x + otherGroup.width / 2,
    otherGroup.y + otherGroup.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(names(page)).toHaveText(["第二画布", "测试画布", "第三画布"]);
  expect(f.writes).toHaveLength(count);
});

test("长按尚未达到500ms时收起侧栏，迟到计时器不得弹菜单", async ({
  page,
  workspace: _workspace,
}) => {
  await directory(page);
  await pauseGestureClock(page);
  await row(page).dispatchEvent("pointerdown", {
    pointerId: 21,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: 100,
    clientY: 150,
  });
  await page.clock.runFor(300);
  await page.getByRole("button", { name: "切换工作空间侧边栏" }).click();
  await expect(row(page)).toBeHidden();
  await page.clock.runFor(1000);
  await expect(
    page.getByRole("menu", { name: "画布 第二画布 的操作", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "切换工作空间侧边栏" }).click();
  await expect(row(page)).toBeVisible();
  await expect(menu(page)).toBeHidden();
});

for (const key of ["Shift+F10", "ContextMenu"]) {
  test(`${key}打开菜单，方向键和首尾键导航，Escape还原焦点`, async ({
    page,
    workspace: _workspace,
  }) => {
    await directory(page);
    await row(page).focus();
    await page.keyboard.press(key);
    await expect(menu(page)).toBeVisible();
    const items = menu(page).getByRole("menuitem");

    await page.keyboard.press("Home");
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("End");
    await expect(items.last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();
    await expect(row(page)).toBeFocused();
    await page.keyboard.press(key);
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect(names(page).first()).toHaveText("第二画布");
    await row(page).focus();
    await page.keyboard.press(key);
    await page.keyboard.press("Home");
    await page.keyboard.press("Space");
    await expect(names(page).first()).toHaveText("测试画布");
  });
}

for (const failure of ["error", "conflict"] as const) {
  test(`${failure}置顶失败后回读原目录且不自动反写`, async ({
    page,
    workspace: _workspace,
  }) => {
    const f = await directory(page);

    f.fail(failure);
    const before = f.reads();

    await row(page).click({ button: "right" });
    await menu(page)
      .getByRole("menuitem", { name: "置顶", exact: true })
      .click();
    await expect.poll(f.reads).toBeGreaterThan(before);
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(names(page)).toHaveText(["测试画布", "第二画布", "第三画布"]);
    expect(f.writes).toHaveLength(1);
    await expect(row(page, "test-canvas")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
}

for (const width of [320, 1024]) {
  test(`${width}窄屏低高度菜单不越界，末项键盘可达且外点关闭`, async ({
    page,
    workspace: _workspace,
  }) => {
    await page.setViewportSize({ width, height: 320 });
    await directory(page);
    if (!(await row(page).isVisible())) {
      await page.getByRole("button", { name: "切换工作空间侧边栏" }).click();
    }

    await row(page).click({ button: "right" });
    await expect(menu(page)).toBeVisible();
    const bounds = (await menu(page).boundingBox())!;

    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(320);
    await page.keyboard.press("End");
    await expect(menu(page).getByRole("menuitem").last()).toBeFocused();
    await expect(menu(page).getByRole("menuitem").last()).toBeInViewport({
      ratio: 1,
    });
    await page.mouse.click(width - 2, 2);
    await expect(menu(page)).toBeHidden();
  });
}

test("触屏长按500ms打开目标菜单，移动超过10px取消且拖拽柄不触发", async ({
  page,
  workspace: _workspace,
}) => {
  await directory(page);
  await pauseGestureClock(page);
  const touch = {
    pointerId: 17,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: 100,
    clientY: 150,
  };

  await row(page).dispatchEvent("pointerdown", touch);
  await page.clock.runFor(499);
  await expect(menu(page)).toBeHidden();
  await page.clock.runFor(1);
  await expect(menu(page)).toBeVisible();
  // 已识别的长按无论继续按住多久，释放后的合成 click 都不能选中目标。
  await page.clock.runFor(2000);
  await row(page).dispatchEvent("pointerup", { ...touch, buttons: 0 });
  await row(page).dispatchEvent("click", { detail: 1 });
  await expect(row(page, "test-canvas")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.keyboard.press("Escape");
  await row(page).dispatchEvent("pointerdown", touch);
  await row(page).dispatchEvent("pointermove", { ...touch, clientX: 111 });
  await page.clock.runFor(600);
  await expect(menu(page)).toBeHidden();
  await row(page).dispatchEvent("pointercancel", touch);
  const handle = (await page
    .locator('[data-canvas-id="second"] .drag-handle')
    .boundingBox())!;
  const cdp = await page.context().newCDPSession(page);

  try {
    // 浏览器登记真实活动触点，允许拖拽实现合法调用 setPointerCapture。
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        {
          x: handle.x + handle.width / 2,
          y: handle.y + handle.height / 2,
          id: 1,
        },
      ],
    });
    await page.clock.runFor(600);
    await expect(menu(page)).toBeHidden();
  } finally {
    try {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    } finally {
      await cdp.detach();
    }
  }
});

test("一次长按结束后下一次独立普通点击仍正常打开画布", async ({
  page,
  workspace: _workspace,
}) => {
  await directory(page);
  await pauseGestureClock(page);
  const touch = {
    pointerId: 19,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: 100,
    clientY: 150,
  };

  await row(page).dispatchEvent("pointerdown", touch);
  await page.clock.runFor(2500);
  await expect(menu(page)).toBeVisible();
  await row(page).dispatchEvent("pointerup", { ...touch, buttons: 0 });
  await row(page).dispatchEvent("click", { detail: 1 });
  await expect(row(page, "test-canvas")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.keyboard.press("Escape");
  await row(page).click();
  await expect(row(page)).toHaveAttribute("aria-current", "page");
  await row(page, "test-canvas").click();
  await expect(row(page, "test-canvas")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await row(page).dispatchEvent("pointerdown", touch);
  await page.clock.runFor(500);
  await expect(menu(page)).toBeVisible();
  // 系统失焦会丢失原 pointerup；下一次独立触摸不能继承旧手势的 click 抑制。
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const nextTouch = { ...touch, pointerId: 20 };

  await row(page).dispatchEvent("pointerdown", nextTouch);
  await row(page).dispatchEvent("pointerup", { ...nextTouch, buttons: 0 });
  await row(page).dispatchEvent("click", { detail: 1 });
  await expect(row(page)).toHaveAttribute("aria-current", "page");
});

test("登录侧栏显示真实版本和可访问的GitHub仓库图标链接", async ({
  page,
  workspace: _workspace,
}) => {
  await expect(
    page.getByText(`v${packageVersion}`, { exact: true }),
  ).toBeVisible();
  const link = page.getByRole("link", { name: "GitHub 仓库", exact: true });

  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute(
    "href",
    "https://github.com/qiudeng7/excalidraw-workspace",
  );
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(link).toHaveAttribute("rel", /noreferrer/);
  await expect(link.locator("svg")).toBeVisible();
});
