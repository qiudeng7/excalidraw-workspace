import { test, expect } from "./fixtures";

test.use({ timezoneId: "America/Los_Angeles" });

test("new canvas names use the user's current local date and remain editable or cancellable", async ({
  page,
  workspace: _workspace,
}) => {
  const names: string[] = [];
  const canvases = [
    {
      id: "test-canvas",
      workspaceId: "test-space",
      name: "测试画布",
      position: 0,
      revision: 0,
      createdAt: "2026-10-14",
      updatedAt: "2026-10-14",
      scene: { elements: [], appState: {}, files: {} },
    },
  ];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/workspaces/test-space/canvases") {
      if (request.method() === "POST") {
        const { name } = request.postDataJSON();

        names.push(name);
        const canvas = {
          ...canvases[0]!,
          id: `new-canvas-${names.length}`,
          name,
          position: canvases.length,
        };

        canvases.push(canvas);

        return route.fulfill({ json: { canvas } });
      }

      return route.fulfill({
        json: { canvases, catalogRevision: names.length },
      });
    }

    const canvas = canvases.find((item) => path === `/api/canvases/${item.id}`);

    if (canvas && request.method() === "GET")
      return route.fulfill({ json: { canvas } });
    if (path === "/api/navigation" && request.method() === "PUT")
      return route.fulfill({
        json: {
          revision: names.length,
          lastWorkspaceId: "test-space",
          lastCanvasId: request.postDataJSON().canvasId,
          workspaces: [],
        },
      });

    return route.fallback();
  });

  // UTC has already reached October 14; the user's local date is still October 13.
  await page.clock.setFixedTime(new Date("2026-10-14T06:30:00Z"));
  const create = page.getByRole("button", { name: "新建画布", exact: true });
  const dialog = page.getByRole("dialog", { name: "新建画布", exact: true });
  const input = dialog.getByLabel("画布名称");

  await create.click();
  await expect(input).toHaveValue("2026年10月13日");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(names).toEqual([]);

  await create.click();
  await expect(input).toHaveValue("2026年10月13日");
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator(".canvas-name")).toHaveCount(2);
  expect(names).toEqual(["2026年10月13日"]);

  // A second click after local midnight must calculate the new day afresh.
  await page.clock.setFixedTime(new Date("2026-10-14T07:30:00Z"));
  await create.click();
  await expect(input).toHaveValue("2026年10月14日");
  await input.fill("  我自己的画布名称  ");
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator(".canvas-name")).toHaveCount(3);
  expect(names).toEqual(["2026年10月13日", "我自己的画布名称"]);

  await page.clock.setFixedTime(new Date("2027-01-03T20:00:00Z"));
  await create.click();
  await expect(input).toHaveValue("2027年1月3日");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(names).toHaveLength(2);
});
