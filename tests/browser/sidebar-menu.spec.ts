// 真实 Chromium 侧栏目录交互，API 全部使用 directory-mock 替身；不证明账号同步或数据库持久化。
// 验证右键/键盘/触屏菜单目标、收藏不改变树顺序、同父移动失败回读、拖拽残留目标清除、
// 视口边界与真实版本链接；后端由 integration 目录测试证明。
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, type WorkspaceFixture } from "./fixtures";
import { installDirectoryMock, type MockNode } from "./directory-mock";

const packageVersion = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version as string;
const nodes: MockNode[] = [
  { kind: "canvas", id: "c1", name: "测试画布", parentId: null },
  { kind: "canvas", id: "c2", name: "第二画布", parentId: null },
  { kind: "canvas", id: "c3", name: "第三画布", parentId: null },
  { kind: "folder", id: "f1", name: "资料", parentId: null },
  { kind: "canvas", id: "c4", name: "资料画布", parentId: "f1" },
];

const openSidebar = async (page: Page) => {
  const trigger = page.getByRole("button", {
    name: "切换工作空间侧边栏",
    exact: true,
  });

  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute("aria-expanded")) === "false")
    await trigger.click();
  await expect(
    page.getByRole("list", { name: "我的文件", exact: true }),
  ).toBeVisible();
};
const setup = async (page: Page, workspace: WorkspaceFixture) => {
  const mock = await installDirectoryMock(page, workspace, {
    nodes,
    recent: "c1",
  });

  await page.reload();
  await openSidebar(page);

  return mock;
};
const nameButton = (page: Page, kind: "canvas" | "folder", id: string) =>
  page.locator(`[data-directory-key="${kind}:${id}"] .canvas-name`);
const menu = (page: Page, label: string) =>
  page.getByRole("menu", { name: label, exact: true });
const treeOrder = (page: Page) =>
  page
    .locator("#directory-list > li[data-directory-key]")
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-directory-key")),
    );

test("右键非当前画布只打开目标菜单，收藏不改变树顺序且没有旧行尾入口", async ({
  page,
  workspace,
}, testInfo) => {
  const f = await setup(page, workspace);

  await expect(page.locator("[data-directory-key] summary")).toHaveCount(0);
  await nameButton(page, "canvas", "c2").click({ button: "right" });
  await expect(menu(page, "画布 第二画布 的操作")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "测试画布", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const before = await treeOrder(page);

  await menu(page, "画布 第二画布 的操作")
    .getByRole("menuitem", { name: "收藏", exact: true })
    .click();
  await expect(
    page
      .getByRole("list", { name: "收藏", exact: true })
      .getByText("第二画布", { exact: true }),
  ).toBeVisible();
  expect(await treeOrder(page)).toEqual(before);
  expect(f.favoritesWrites).toEqual([
    {
      source: { kind: "canvas", id: "c2" },
      favorite: true,
      catalogRevision: 0,
    },
  ]);
  const screenshot = testInfo.outputPath("sidebar-favorite-menu.png");

  await page.screenshot({ path: screenshot });
  await testInfo.attach("侧栏收藏菜单与版本仓库入口", {
    path: screenshot,
    contentType: "image/png",
  });
  await nameButton(page, "canvas", "c2").click({ button: "right" });
  await menu(page, "画布 第二画布 的操作")
    .getByRole("menuitem", { name: "取消收藏", exact: true })
    .click();
  await expect(
    page
      .getByRole("list", { name: "收藏", exact: true })
      .getByText("第二画布", {
        exact: true,
      }),
  ).toHaveCount(0);
  expect(await treeOrder(page)).toEqual(before);
});

test("菜单上移只调整同父顺序，失败回读原目录，首末项禁用", async ({
  page,
  workspace,
}) => {
  const f = await setup(page, workspace);

  await nameButton(page, "canvas", "c2").click({ button: "right" });
  await menu(page, "画布 第二画布 的操作")
    .getByRole("menuitem", { name: "↑ 上移", exact: true })
    .click();
  await expect
    .poll(() => treeOrder(page))
    .toEqual(["canvas:c2", "canvas:c1", "canvas:c3", "folder:f1"]);
  expect(f.moves[0]?.body).toMatchObject({
    source: { kind: "canvas", id: "c2" },
    parentId: null,
    target: { kind: "canvas", id: "c1" },
    placement: "before",
  });
  const settled = await treeOrder(page);

  f.failMove();
  await nameButton(page, "canvas", "c3").click({ button: "right" });
  await menu(page, "画布 第三画布 的操作")
    .getByRole("menuitem", { name: "↑ 上移", exact: true })
    .click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  expect(await treeOrder(page)).toEqual(settled);
  await nameButton(page, "canvas", "c3").click({ button: "right" });
  await menu(page, "画布 第三画布 的操作")
    .getByRole("menuitem", { name: "↑ 上移", exact: true })
    .click();
  await expect
    .poll(() => treeOrder(page))
    .toEqual(["canvas:c2", "canvas:c3", "canvas:c1", "folder:f1"]);
  await nameButton(page, "canvas", "c2").click({ button: "right" });
  await expect(
    menu(page, "画布 第二画布 的操作").getByRole("menuitem", {
      name: "↑ 上移",
      exact: true,
    }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await nameButton(page, "folder", "f1").click({ button: "right" });
  await expect(
    menu(page, "文件夹 资料 的操作").getByRole("menuitem", {
      name: "↓ 下移",
      exact: true,
    }),
  ).toBeDisabled();
});

test("拖动经过其他行后按 Esc 取消，不提交残留移动目标", async ({
  page,
  workspace,
}) => {
  const f = await setup(page, workspace);
  const handle = (await page
    .locator('#directory-list [data-directory-key="canvas:c2"]')
    .boundingBox())!;
  const target = (await nameButton(page, "canvas", "c1").boundingBox())!;
  const folder = (await nameButton(page, "folder", "f1").boundingBox())!;

  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + 4, {
    steps: 8,
  });
  await page.mouse.move(
    folder.x + folder.width / 2,
    folder.y + folder.height / 2,
    { steps: 8 },
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(f.moves).toHaveLength(0);
  expect(await treeOrder(page)).toEqual([
    "canvas:c1",
    "canvas:c2",
    "canvas:c3",
    "folder:f1",
  ]);
});

for (const key of ["Shift+F10", "ContextMenu"]) {
  test(`${key}打开菜单，方向键和首尾键导航，Escape还原焦点`, async ({
    page,
    workspace,
  }) => {
    await setup(page, workspace);
    const row = nameButton(page, "canvas", "c2");

    await row.focus();
    await page.keyboard.press(key);
    const target = menu(page, "画布 第二画布 的操作");

    await expect(target).toBeVisible();
    const items = target.getByRole("menuitem");

    await page.keyboard.press("Home");
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("End");
    await expect(items.last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(target).toBeHidden();
    await expect(row).toBeFocused();
    await page.keyboard.press(key);
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect(
      page
        .getByRole("list", { name: "收藏", exact: true })
        .getByText("第二画布", { exact: true }),
    ).toBeVisible();
  });
}

test("收藏失败后回读原树且不自动反写", async ({ page, workspace }) => {
  const f = await setup(page, workspace);

  f.failFavorite(true);
  const before = await treeOrder(page);

  await nameButton(page, "canvas", "c2").click({ button: "right" });
  await menu(page, "画布 第二画布 的操作")
    .getByRole("menuitem", { name: "收藏", exact: true })
    .click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  expect(await treeOrder(page)).toEqual(before);
  expect(
    await page
      .getByRole("list", { name: "收藏", exact: true })
      .getByText("第二画布", { exact: true })
      .count(),
  ).toBe(0);
});

for (const width of [320, 1024]) {
  test(`${width}窄屏低高度菜单不越界，末项键盘可达且外点关闭`, async ({
    page,
    workspace,
  }) => {
    await page.setViewportSize({ width, height: 320 });
    await setup(page, workspace);
    await page
      .getByRole("button", { name: "画布 第二画布 的操作", exact: true })
      .click();
    const target = menu(page, "画布 第二画布 的操作");

    await expect(target).toBeVisible();
    const bounds = (await target.boundingBox())!;

    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(320);
    await page.keyboard.press("End");
    await expect(target.getByRole("menuitem").last()).toBeFocused();
    await expect(target.getByRole("menuitem").last()).toBeInViewport({
      ratio: 1,
    });
    await page.mouse.click(width - 2, 2);
    await expect(target).toBeHidden();
  });
}

test.describe("触屏目录入口", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("轻触行尾操作打开菜单并可轻触关闭，文件夹入口同样可达", async ({
    page,
    workspace,
  }) => {
    await setup(page, workspace);
    const more = page.getByRole("button", {
      name: "画布 第二画布 的操作",
      exact: true,
    });

    await expect(more).toBeVisible();
    await more.tap();
    const target = menu(page, "画布 第二画布 的操作");

    await expect(target).toBeVisible();
    const bounds = (await target.boundingBox())!;

    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    await page.getByText("画布空间", { exact: true }).tap();
    await expect(target).toBeHidden();
    await page
      .getByRole("button", { name: "文件夹 资料 的操作", exact: true })
      .tap();
    await expect(menu(page, "文件夹 资料 的操作")).toBeVisible();
  });
});

test("登录侧栏显示真实版本和可访问的GitHub仓库图标链接", async ({
  page,
  workspace,
}) => {
  await setup(page, workspace);
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
