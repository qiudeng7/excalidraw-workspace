import { test, expect } from "./fixtures";
import type { RecycleEntry } from "../../shared/contracts";

const entry = (
  kind: RecycleEntry["kind"],
  id: string,
  name: string,
): RecycleEntry => ({
  kind,
  id,
  name,
  deletedAt: new Date(Date.now() - 86400000).toISOString(),
  expiresAt: new Date(Date.now() + 29 * 86400000).toISOString(),
  ...(kind === "canvas"
    ? { workspaceId: "test-space", workspaceName: "测试空间" }
    : {}),
});

test("recycle panel restores files and requires explicit confirmation before permanent deletion", async ({
  page,
  workspace: _workspace,
}) => {
  let entries = [
    entry("canvas", "restore-canvas", "待恢复画布"),
    entry("workspace", "purge-space", "待删除空间"),
  ];
  const actions: string[] = [];

  await page.route("**/api/recycle-bin**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (request.method() === "GET") return route.fulfill({ json: { entries } });
    actions.push(`${request.method()} ${path}`);
    if (request.method() === "DELETE")
      expect(request.postDataJSON()).toEqual({ confirm: true });
    entries = entries.filter((value) => !path.endsWith(`/${value.id}`));

    return route.fulfill({ json: {} });
  });
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "回收站", exact: true });

  await expect(
    panel.getByText("剩余 29 天", { exact: false }).first(),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/recycle-bin-light.png" });
  await panel
    .getByRole("button", { name: "恢复 待恢复画布", exact: true })
    .click();
  await expect(panel.getByText("待恢复画布", { exact: true })).toHaveCount(0);
  await expect(page.locator(".excalidraw")).toBeVisible();
  await panel
    .getByRole("button", { name: "彻底删除 待删除空间", exact: true })
    .click();
  const confirm = page.getByRole("dialog", { name: "彻底删除", exact: true });

  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  expect(actions).toHaveLength(1);
  await panel
    .getByRole("button", { name: "彻底删除 待删除空间", exact: true })
    .click();
  await confirm.getByRole("button", { name: "彻底删除", exact: true }).click();
  await expect(panel.getByText("回收站是空的")).toBeVisible();
  expect(actions).toEqual([
    "POST /api/recycle-bin/canvas/restore-canvas",
    "DELETE /api/recycle-bin/workspace/purge-space",
  ]);
  await expect(
    panel.getByRole("button", { name: "关闭回收站", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "回收站", exact: true }),
  ).toBeFocused();
});

test("recycle failures remain visible and can be retried without affecting the current editor", async ({
  page,
  workspace: _workspace,
}) => {
  let fail = true;

  await page.route("**/api/recycle-bin", (route) =>
    route.fulfill(
      fail
        ? {
            status: 503,
            json: {
              error: { code: "UNAVAILABLE", message: "回收站暂时不可用" },
            },
          }
        : { json: { entries: [] } },
    ),
  );
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "回收站", exact: true });

  await expect(panel.getByRole("alert")).toContainText("回收站暂时不可用");
  fail = false;
  await panel.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(panel.getByText("回收站是空的")).toBeVisible();
});

test("dark mobile recycle panel keeps long filenames and actions within the viewport", async ({
  page,
  workspace: _workspace,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.route("**/api/recycle-bin", (route) =>
    route.fulfill({
      json: {
        entries: [
          entry("canvas", "mobile", "一张名称很长很长很长很长的待恢复画布"),
          entry("workspace", "space", "历史工作空间"),
        ],
      },
    }),
  );
  if (
    !(await page
      .getByRole("button", { name: "回收站", exact: true })
      .isVisible())
  )
    await page.getByRole("button", { name: "切换工作空间侧边栏" }).click();
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "回收站", exact: true });

  await expect(
    panel.getByRole("button", { name: "恢复 历史工作空间", exact: true }),
  ).toBeVisible();
  expect(
    await panel
      .locator(".recycle-card")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/recycle-bin-dark-mobile.png" });
});
