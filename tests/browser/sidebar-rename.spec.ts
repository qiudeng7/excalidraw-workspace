// 真实 Chromium 侧栏行内重命名；目录 API 使用 directory-mock 替身。
// 验证右键菜单进入行内输入、Enter 提交并 trim、Esc/空名称不写入、失败保留旧名，
// 以及双击不再触发重命名（只按普通点击打开画布）。不证明数据库持久化。
import type { Page } from "@playwright/test";
import { test, expect, type WorkspaceFixture } from "./fixtures";
import { installDirectoryMock } from "./directory-mock";

const nodes = [
  { kind: "canvas" as const, id: "c1", name: "测试画布", parentId: null },
  { kind: "canvas" as const, id: "c2", name: "第二个画布", parentId: null },
];

const setup = async (page: Page, workspace: WorkspaceFixture) => {
  const mock = await installDirectoryMock(page, workspace, {
    nodes,
    recent: "c1",
  });

  await page.reload();
  const toggle = page.getByRole("button", {
    name: "切换工作空间侧边栏",
    exact: true,
  });

  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await expect(
    page.getByRole("list", { name: "我的文件", exact: true }),
  ).toBeVisible();

  return mock;
};
const nameButton = (page: Page, id: string) =>
  page.locator(
    `#directory-list [data-directory-key="canvas:${id}"] .canvas-name`,
  );
const menu = (page: Page, name: string) =>
  page.getByRole("menu", { name: `画布 ${name} 的操作`, exact: true });
const input = (page: Page, id: string) =>
  page.locator(
    `#directory-list [data-directory-key="canvas:${id}"] input[aria-label="重命名画布名称"]`,
  );
const openRename = async (page: Page, id: string, name: string) => {
  await nameButton(page, id).click({ button: "right" });
  await menu(page, name)
    .getByRole("menuitem", { name: "重命名", exact: true })
    .click();
  await expect(input(page, id)).toBeVisible();
};

test("右键重命名只改目标并 trim，当前画布不变", async ({ page, workspace }) => {
  const mock = await setup(page, workspace);

  await openRename(page, "c2", "第二个画布");
  await expect(input(page, "c2")).toHaveValue("第二个画布");
  await input(page, "c2").fill("  行内重命名  ");
  await input(page, "c2").press("Enter");
  await expect(nameButton(page, "c2")).toHaveAttribute(
    "aria-label",
    "行内重命名",
  );
  await expect(nameButton(page, "c1")).toHaveAttribute(
    "aria-label",
    "测试画布",
  );
  await expect(
    page.getByRole("tab", { name: "测试画布", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(mock.renames).toEqual([{ id: "c2", name: "行内重命名" }]);
});

test("空名称和 Esc 不保存，取消按钮也不写入", async ({ page, workspace }) => {
  const mock = await setup(page, workspace);

  await nameButton(page, "c2").click();
  await expect(
    page.getByRole("tab", { name: "第二个画布", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await openRename(page, "c2", "第二个画布");
  await input(page, "c2").fill("   ");
  await input(page, "c2").press("Enter");
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(input(page, "c2")).toBeVisible();
  expect(mock.renames).toEqual([]);
  await input(page, "c2").press("Escape");
  await expect(input(page, "c2")).toHaveCount(0);

  await nameButton(page, "c2").click({ button: "right" });
  await menu(page, "第二个画布")
    .getByRole("menuitem", { name: "重命名", exact: true })
    .click();
  await expect(input(page, "c2")).toBeVisible();
  await page
    .locator(
      '#directory-list [data-directory-key="canvas:c2"] button[aria-label="取消编辑名称"]',
    )
    .click();
  await expect(input(page, "c2")).toHaveCount(0);
  expect(mock.renames).toEqual([]);
  await nameButton(page, "c2").dblclick();
  await expect(input(page, "c2")).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "第二个画布", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("重命名失败保留旧名，菜单可再次进入并成功", async ({
  page,
  workspace,
}) => {
  const mock = await setup(page, workspace);

  mock.failRename();
  await openRename(page, "c1", "测试画布");
  await input(page, "c1").fill("失败名称");
  await input(page, "c1").press("Enter");
  await expect(page.getByRole("alert").first()).toContainText("重命名暂时失败");
  await expect(input(page, "c1")).toBeVisible();
  await expect(input(page, "c1")).toHaveValue("失败名称");
  await expect(
    page.getByRole("tab", { name: "测试画布", exact: true }),
  ).toContainText("测试画布");
  expect(mock.renames).toEqual([{ id: "c1", name: "失败名称" }]);

  await input(page, "c1").press("Escape");
  await expect(input(page, "c1")).toHaveCount(0);
  await expect(nameButton(page, "c1")).toHaveAttribute(
    "aria-label",
    "测试画布",
  );
  await openRename(page, "c1", "测试画布");
  await input(page, "c1").fill("第二个名称");
  await input(page, "c1").press("Enter");
  await expect(nameButton(page, "c1")).toHaveAttribute(
    "aria-label",
    "第二个名称",
  );
  expect(mock.renames).toEqual([
    { id: "c1", name: "失败名称" },
    { id: "c1", name: "第二个名称" },
  ]);
});
