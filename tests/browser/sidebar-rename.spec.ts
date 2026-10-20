import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

async function directory(page: Page) {
  const canvases = ["test-canvas", "other-canvas"].map((id, position) => ({
    id,
    workspaceId: "test-space",
    name: position ? "第二个画布" : "测试画布",
    position,
    revision: 0,
    createdAt: "2026-10-14",
    updatedAt: "2026-10-14",
    scene: { elements: [], appState: {}, files: {} },
  }));
  const patches: { id: string; name: string }[] = [];
  let releaseLoad!: () => void;
  const loading = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  let failRename = false;
  let reads = 0;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/workspaces/test-space/canvases")
      return route.fulfill({ json: { canvases, catalogRevision: 0 } });
    if (path === "/api/navigation" && request.method() === "PUT")
      return route.fulfill({
        json: {
          revision: 1,
          lastWorkspaceId: "test-space",
          lastCanvasId: request.postDataJSON().canvasId,
          workspaces: [],
        },
      });
    const canvas = canvases.find((item) => path === `/api/canvases/${item.id}`);

    if (canvas && request.method() === "PATCH") {
      const { name } = request.postDataJSON();

      patches.push({ id: canvas.id, name });
      if (failRename)
        return route.fulfill({
          status: 503,
          json: { error: { code: "OFFLINE", message: "重命名暂时失败" } },
        });
      canvas.name = name;

      return route.fulfill({ json: { canvas } });
    }

    if (canvas?.id === "other-canvas" && request.method() === "GET") {
      reads++;
      await loading;

      return route.fulfill({ json: { canvas } });
    }

    return route.fallback();
  });
  await page.reload();
  await expect(page.locator(".excalidraw")).toBeVisible();
  await expect(page.locator(".canvas-name")).toHaveCount(2);

  return {
    patches,
    releaseLoad,
    reads: () => reads,
    failRename: (fail: boolean) => {
      failRename = fail;
    },
  };
}

test("double-click waits for the first selection and renames the clicked canvas", async ({
  page,
  workspace: _workspace,
}) => {
  const mock = await directory(page);
  const target = page.locator('[data-canvas-id="other-canvas"] .canvas-name');
  const dialog = page.getByRole("dialog", { name: "重命名画布", exact: true });

  try {
    await target.dblclick();
    await expect.poll(mock.reads).toBe(1);
    await expect(dialog).toBeHidden();
  } finally {
    mock.releaseLoad();
  }

  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("画布名称")).toHaveValue("第二个画布");
  await dialog.getByLabel("画布名称").fill("  双击后的名称  ");
  await dialog.getByRole("button", { name: "保存名称" }).click();
  await expect(target).toHaveAttribute("aria-label", "双击后的名称");
  await expect(target).toHaveAttribute("aria-current", "page");
  await expect(
    page.locator('[data-canvas-id="test-canvas"] .canvas-name'),
  ).toHaveAttribute("aria-label", "测试画布");
  expect(mock.patches).toEqual([{ id: "other-canvas", name: "双击后的名称" }]);
});

test("single-click still opens immediately; cancelled, blank and unchanged names do not save", async ({
  page,
  workspace: _workspace,
}) => {
  const mock = await directory(page);
  const target = page.locator('[data-canvas-id="other-canvas"] .canvas-name');
  const dialog = page.getByRole("dialog", { name: "重命名画布", exact: true });

  try {
    await target.click();
    await expect.poll(mock.reads).toBe(1);
    await expect(dialog).toBeHidden();
  } finally {
    mock.releaseLoad();
  }

  await expect(target).toHaveAttribute("aria-current", "page");
  await expect(page.locator('.save-state[role="status"]')).not.toHaveText(
    "正在校验版本…",
  );
  await target.dblclick();
  await dialog.getByLabel("画布名称").fill("   ");
  await expect(dialog.getByRole("button", { name: "保存名称" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await target.dblclick();
  await dialog.getByRole("button", { name: "保存名称" }).click();
  await expect(dialog).toBeHidden();
  await target.dblclick();
  await dialog.getByLabel("画布名称").fill("取消的名称");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(target).toHaveAttribute("aria-label", "第二个画布");
  expect(mock.patches).toEqual([]);
});

test("rename failure retains the name; menu and drag controls do not trigger double-click rename", async ({
  page,
  workspace: _workspace,
}) => {
  const mock = await directory(page);
  const row = page.locator('[data-canvas-id="test-canvas"]');
  const target = row.locator(".canvas-name");
  const dialog = page.getByRole("dialog", { name: "重命名画布", exact: true });

  await row.locator(".drag-handle").dblclick();
  await expect(dialog).toBeHidden();
  await target.click({ button: "right" });
  await expect(dialog).toBeHidden();
  await page.keyboard.press("Escape");
  mock.failRename(true);
  await target.dblclick();
  await dialog.getByLabel("画布名称").fill("新的名称");
  await dialog.getByRole("button", { name: "保存名称" }).click();
  await expect(page.getByRole("alert")).toContainText("重命名暂时失败");
  await expect(target).toHaveAttribute("aria-label", "测试画布");
  mock.failRename(false);
  // The existing menu remains keyboard accessible and uses the same dialog.
  await target.focus();
  await page.keyboard.press("Shift+F10");
  await page
    .getByRole("menu", { name: "画布 测试画布 的操作", exact: true })
    .getByRole("menuitem", { name: "重命名", exact: true })
    .click();
  await dialog.getByLabel("画布名称").fill("第二个画布");
  await dialog.getByRole("button", { name: "保存名称" }).click();
  await expect(target).toHaveAttribute("aria-label", "第二个画布");
  expect(mock.patches).toEqual([
    { id: "test-canvas", name: "新的名称" },
    { id: "test-canvas", name: "第二个画布" },
  ]);
});
