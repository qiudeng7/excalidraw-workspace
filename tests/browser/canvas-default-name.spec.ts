// 真实 Chromium 验证侧栏新建画布的本地日期、跨午夜重算、编辑与取消。
// 目录 API 使用有状态替身，不证明数据库持久化；真实排序由 integration 保护。
import { test, expect } from "./fixtures";
import { installDirectoryMock } from "./directory-mock";

test.use({ timezoneId: "America/Los_Angeles" });

test("新建画布每次使用当前本地日期，允许编辑或取消", async ({
  page,
  workspace,
}) => {
  const mock = await installDirectoryMock(page, workspace, {
    nodes: [
      { kind: "canvas", id: "test-canvas", name: "测试画布", parentId: null },
    ],
    recent: "test-canvas",
  });

  // 时钟继续前进，避免冻结 Date.now 触发 Vue capture/bubble 事件时间保护。
  await page.clock.install({ time: new Date("2026-10-14T06:30:00Z") });
  await page.reload();
  await expect(page.locator(".excalidraw")).toBeVisible();
  const toggle = page.getByRole("button", {
    name: "切换工作空间侧边栏",
    exact: true,
  });

  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  const create = page.locator(".resource-tree").getByRole("button", {
    name: "新建画布",
    exact: true,
  });
  const input = page.getByRole("textbox", {
    name: "新建画布名称",
    exact: true,
  });

  await create.click();
  await expect(input).toHaveValue("2026年10月13日");
  await page.getByRole("button", { name: "取消编辑名称", exact: true }).click();
  await expect(input).toHaveCount(0);
  expect(mock.nodes).toHaveLength(1);

  await create.click();
  await expect(input).toHaveValue("2026年10月13日");
  await page.getByRole("button", { name: "确认名称", exact: true }).click();
  await expect(input).toHaveCount(0);
  expect(mock.nodes.at(-1)?.name).toBe("2026年10月13日");

  await page.clock.setSystemTime(new Date("2026-10-14T07:30:00Z"));
  await create.click();
  await expect(input).toHaveValue("2026年10月14日");
  await input.fill("  我自己的画布名称  ");
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  expect(mock.nodes.at(-1)?.name).toBe("我自己的画布名称");

  await page.clock.setSystemTime(new Date("2027-01-03T20:00:00Z"));
  await create.click();
  await expect(input).toHaveValue("2027年1月3日");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  expect(mock.nodes).toHaveLength(3);
});
