// 真实 Chromium 运行侧栏批选与批量命令；目录 HTTP 全部是本目录 directory-mock 的有状态替身。
// 保护：修饰键点击不打开画布、Shift 锚点稳定、空白框选（含缩框回退与不重读目录）、
// 选中组拖动走批量接口而未选行走单项、批量菜单与确认计数、删除后精确关闭与一次撤销、
// 拒绝/丢响应/刷新失败三态、触屏显式多选入口、收藏点击清树选择。
// 替身不证明数据库、事务、权限或真实持久化；这些属于 tests/integration/directory-batch.test.ts。
// 共享画布跳转不在本文件覆盖（点击会离开当前页面），只覆盖收藏入口。
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { installDirectoryMock, type MockNode } from "./directory-mock";

const nodes = (): MockNode[] => [
  { kind: "canvas", id: "c1", name: "画布一", parentId: null, position: 0 },
  { kind: "folder", id: "f1", name: "资料", parentId: null, position: 1 },
  { kind: "canvas", id: "c3", name: "画布三", parentId: "f1", position: 0 },
  { kind: "folder", id: "f2", name: "子目录", parentId: "f1", position: 1 },
  { kind: "canvas", id: "c4", name: "画布四", parentId: "f2", position: 0 },
  { kind: "canvas", id: "c2", name: "画布二", parentId: null, position: 2 },
  { kind: "folder", id: "f3", name: "目标", parentId: null, position: 3 },
  {
    kind: "canvas",
    id: "c5",
    name: "画布五",
    parentId: null,
    position: 4,
    favorite: true,
  },
];

const row = (page: Page, kind: "canvas" | "folder", id: string) =>
  page.locator(`#directory-list [data-directory-key="${kind}:${id}"]`);
const rowName = (page: Page, kind: "canvas" | "folder", id: string) =>
  row(page, kind, id).locator("button.directory-name");
const menu = (page: Page) => page.getByRole("menu");
const selected = async (locator: Locator) =>
  (await locator.getAttribute("aria-pressed")) === "true" ||
  (await locator.locator('[aria-pressed="true"]').count()) > 0;
const expectSelected = (locator: Locator) =>
  expect.poll(() => selected(locator)).toBe(true);
const expectUnselected = (locator: Locator) =>
  expect.poll(() => selected(locator)).toBe(false);
const withKeys = async (
  page: Page,
  keys: string[],
  action: () => Promise<void>,
) => {
  for (const key of keys) await page.keyboard.down(key);
  try {
    await action();
  } finally {
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
  }
};
/** 公共 mock 只注册路由、不刷新页面；每个用例安装后必须重载并等目录真正渲染。 */
const mountSidebar = async (page: Page) => {
  await page.reload();
  const toggle = page.getByRole("button", {
    name: "切换工作空间侧边栏",
    exact: true,
  });

  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await expect(
    page.getByRole("list", { name: "我的文件", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("#directory-list [data-directory-key]").first(),
  ).toBeVisible();
};
const openFolder = async (page: Page, id: string, name: string) => {
  await row(page, "folder", id)
    .getByRole("button", { name, exact: true })
    .click();
  await expect(
    row(page, "folder", id).getByRole("button", { name, exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
};
/** 资源树必须留出真实可达的起框空白：先找底部空白，再找行外侧带。 */
const blankPoint = async (page: Page) =>
  page.evaluate(() => {
    const scroll = document.querySelector(".sidebar-scroll");
    const tree = document.querySelector(".resource-tree");

    if (!(scroll instanceof HTMLElement) || !(tree instanceof HTMLElement))
      return null;
    const box = scroll.getBoundingClientRect();
    const rows = [...tree.querySelectorAll("[data-directory-key]")].map(
      (element) => element.getBoundingClientRect(),
    );

    if (!rows.length) return null;
    const lastBottom = Math.max(...rows.map((rect) => rect.bottom));
    const bottom = Math.min(box.bottom - 6, lastBottom + 48);

    if (bottom > lastBottom + 16 && bottom > box.top + 40)
      return { x: box.left + box.width / 2, y: bottom };

    for (let x = box.right - 4; x > box.right - 28; x -= 2) {
      const y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);

      if (
        hit &&
        hit.closest(".resource-tree") === tree &&
        !hit.closest("[data-directory-key]") &&
        !hit.closest("button") &&
        !hit.closest('[role="menu"]')
      )
        return { x, y };
    }

    return null;
  });
/** 当前批选集合（行本身或行内元素带 aria-pressed）。 */
const selectedKeys = async (page: Page): Promise<string[]> =>
  page
    .locator("#directory-list [data-directory-key]")
    .evaluateAll((rows) =>
      rows
        .filter(
          (row) =>
            row.getAttribute("aria-pressed") === "true" ||
            !!row.querySelector('[aria-pressed="true"]'),
        )
        .map((row) => row.getAttribute("data-directory-key")!),
    );
/**
 * 行外侧边 gutter 起框点：必须命中 .resource-tree 自身（padding 区），
 * 而不是行、按钮或 .sidebar-scroll 的外侧留白。
 */
const gutterPoint = async (page: Page, y: number) => {
  const point = await page.evaluate((targetY) => {
    const scroll = document.querySelector(".sidebar-scroll");
    const tree = document.querySelector(".resource-tree");

    if (!(scroll instanceof HTMLElement) || !(tree instanceof HTMLElement))
      return null;
    const box = tree.getBoundingClientRect();

    for (let x = box.right - 2; x > box.right - 24; x -= 1) {
      const hit = document.elementFromPoint(x, targetY);

      if (
        hit &&
        hit.closest(".resource-tree") === tree &&
        !hit.closest("[data-directory-key]") &&
        !hit.closest("button") &&
        !hit.closest('[role="menu"]')
      )
        return { x, y: targetY };
    }

    return null;
  }, y);

  expect(
    point,
    "资源树没有可起框的侧边 gutter（长列表也要能起框，属产品缺口）",
  ).not.toBeNull();

  return point!;
};
const dragBox = async (
  page: Page,
  options: { modifiers?: string[]; to: Locator },
) => {
  const start = await blankPoint(page);

  expect(start, "资源树需要留出可起框的空白区域").not.toBeNull();
  const target = (await options.to.boundingBox())!;

  for (const key of options.modifiers ?? []) await page.keyboard.down(key);
  await page.mouse.move(start!.x, start!.y);
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 10 },
  );

  return {
    finish: async () => {
      await page.mouse.up();
      for (const key of options.modifiers ?? []) await page.keyboard.up(key);
    },
  };
};
const drawRectangle = async (page: Page) => {
  const box = (await page.locator(".excalidraw canvas").last().boundingBox())!;

  await page.getByTestId("toolbar-rectangle").first().click();
  await page.mouse.move(box.x + 300, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 380, box.y + 260, { steps: 6 });
  await page.mouse.up();
};

test("修饰键点击只改选择：不打开画布、不展开文件夹、Shift 锚点稳定", async ({
  page,
  workspace,
}) => {
  const f = await installDirectoryMock(page, workspace, { nodes: nodes() });

  await mountSidebar(page);
  await openFolder(page, "f1", "资料");

  // 普通单击仍打开画布、清空批选并把锚点设为该行。
  await rowName(page, "canvas", "c1").click();
  await expectUnselected(row(page, "canvas", "c1"));
  const openedBefore = f.opened.length;

  // Ctrl 单击是切换：选中 → 取消 → 再选中，锚点始终回到 c3。
  await withKeys(page, ["Control"], () =>
    rowName(page, "canvas", "c3").click(),
  );
  await expectSelected(row(page, "canvas", "c3"));
  await withKeys(page, ["Control"], () =>
    rowName(page, "canvas", "c3").click(),
  );
  await expectUnselected(row(page, "canvas", "c3"));
  await withKeys(page, ["Control"], () =>
    rowName(page, "canvas", "c3").click(),
  );
  await expectSelected(row(page, "canvas", "c3"));

  // 锚点在 c3；连续两次 Shift 都从同一锚点重算，第二次更近时集合必须收缩。
  await withKeys(page, ["Shift"], () => rowName(page, "canvas", "c2").click());
  await expectSelected(row(page, "canvas", "c3"));
  await expectSelected(row(page, "folder", "f2"));
  await expectSelected(row(page, "canvas", "c2"));
  await withKeys(page, ["Shift"], () => rowName(page, "canvas", "c3").click());
  await expectSelected(row(page, "canvas", "c3"));
  await expectUnselected(row(page, "folder", "f2"));
  await expectUnselected(row(page, "canvas", "c2"));

  // Ctrl+Shift 追加区间，仍从 c3 起算。
  await withKeys(page, ["Control", "Shift"], () =>
    rowName(page, "canvas", "c2").click(),
  );
  await expectSelected(row(page, "folder", "f2"));
  await expectSelected(row(page, "canvas", "c2"));

  // 修饰键从不打开画布或展开文件夹。
  await withKeys(page, ["Control"], () =>
    rowName(page, "folder", "f3").click(),
  );
  await expectSelected(row(page, "folder", "f3"));
  await expect(
    row(page, "folder", "f3").getByRole("button", {
      name: "目标",
      exact: true,
    }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(f.opened.length).toBe(openedBefore);
});

test("空白框选命中已加载行、缩框回退、Esc 恢复起始选择且不重读目录", async ({
  page,
  workspace,
}) => {
  const f = await installDirectoryMock(page, workspace, { nodes: nodes() });

  await mountSidebar(page);
  const openedBefore = f.opened.length;
  const readsBefore = f.reads.length;
  const first = await dragBox(page, { to: rowName(page, "canvas", "c2") });

  await expectSelected(row(page, "canvas", "c2"));
  await expectSelected(row(page, "folder", "f3"));
  await expectSelected(row(page, "canvas", "c5"));
  await expectUnselected(row(page, "canvas", "c1"));

  // 无修饰框选每帧从起始快照重算：指针缩到只剩最后一行时，早先命中的行必须回退。
  const last = (await rowName(page, "canvas", "c5").boundingBox())!;

  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, {
    steps: 8,
  });
  await expectUnselected(row(page, "canvas", "c2"));
  await expectSelected(row(page, "canvas", "c5"));
  await first.finish();
  expect(f.opened.length).toBe(openedBefore);

  // Esc 取消框选恢复起始选择：第二次框选前集合是 [c5]。
  const again = await dragBox(page, { to: rowName(page, "folder", "f3") });

  await expectSelected(row(page, "folder", "f3"));
  await page.keyboard.press("Escape");
  await expectUnselected(row(page, "folder", "f3"));
  await expectSelected(row(page, "canvas", "c5"));
  await again.finish();
  await expectUnselected(row(page, "folder", "f3"));
  expect(f.reads.length).toBe(readsBefore, "框选不得重新读取目录");
});

test("Ctrl 框选对起始快照异或、Shift 框选取并集", async ({
  page,
  workspace,
}) => {
  await installDirectoryMock(page, workspace, { nodes: nodes() });
  await mountSidebar(page);
  await openFolder(page, "f1", "资料");

  await withKeys(page, ["Control"], () =>
    rowName(page, "canvas", "c3").click(),
  );
  await expectSelected(row(page, "canvas", "c3"));

  // Shift 框选是并集：c3 保持选中，新增框内行。
  const union = await dragBox(page, {
    modifiers: ["Shift"],
    to: rowName(page, "canvas", "c2"),
  });

  await expectSelected(row(page, "canvas", "c3"));
  await expectSelected(row(page, "canvas", "c2"));
  await union.finish();

  // Ctrl 框选与起始快照异或：起点 c3 已在集合内，框到它时必须变成未选中，新命中的 f2 进入集合。
  const xor = await dragBox(page, {
    modifiers: ["Control"],
    to: rowName(page, "canvas", "c3"),
  });

  await expectUnselected(row(page, "canvas", "c3"));
  await expectSelected(row(page, "folder", "f2"));
  await xor.finish();
});

test("侧边 gutter 起框后靠边自动滚动：命中按新坐标重算且不触发分页", async ({
  page,
  workspace,
}) => {
  const f = await installDirectoryMock(page, workspace, { count: 100 });

  await mountSidebar(page);
  const cursorReads = () => f.reads.filter((entry) => entry.cursor).length;
  const before = cursorReads();
  const seeded = (await page
    .locator('#directory-list [data-directory-key="canvas:canvas-2"]')
    .boundingBox())!;
  const start = await gutterPoint(page, seeded.y + seeded.height / 2);
  const scroll = page.locator(".sidebar-scroll");
  const box = (await scroll.boundingBox())!;

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // 零位移不应选中任何行（正面积相交才算命中）。
  await expect.poll(() => selectedKeys(page)).toEqual([]);

  // 指针停在滚动容器下边缘，触发靠边自动滚动。
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 6, {
    steps: 8,
  });
  const firstBatchBottomVisible = () =>
    page.evaluate(() => {
      const container = document.querySelector(".sidebar-scroll");
      const row = document.querySelector(
        '#directory-list [data-directory-key="canvas:canvas-29"]',
      );

      if (!(container instanceof HTMLElement) || !(row instanceof HTMLElement))
        return false;
      const viewport = container.getBoundingClientRect();
      const rect = row.getBoundingClientRect();

      return viewport.bottom >= rect.bottom - 1 && viewport.top <= rect.top + 1;
    });

  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop), {
      message: "指针贴住下边缘时必须自动滚动",
    })
    .toBeGreaterThan(0);
  await expect
    .poll(firstBatchBottomVisible, {
      message: "自动滚动应能到达首批已加载行的底部",
    })
    .toBe(true);
  // 滚动后按新坐标重算命中：首批最后一行被选中，而起点之上的行保持未选。
  await expect.poll(() => selectedKeys(page)).toContain("canvas:canvas-29");
  expect(await selectedKeys(page)).not.toContain("canvas:canvas-0");
  expect(cursorReads()).toBe(before, "框选期间不得触发 cursor 分页");

  // Esc 取消手势并恢复起始选择（为空），随后抬手不再改变集合。
  await page.keyboard.press("Escape");
  await expect.poll(() => selectedKeys(page)).toEqual([]);
  await page.mouse.up();
  await expect.poll(() => selectedKeys(page)).toEqual([]);
});

test("拖动已选行提交一次批量移动；拖未选行走原单项路径；组拖入收藏有提示不提交", async ({
  page,
  workspace,
}) => {
  const f = await installDirectoryMock(page, workspace, { nodes: nodes() });

  await mountSidebar(page);

  // 未选行拖动：先清选择，再走既有单项排序接口。
  const c2Box = (await row(page, "canvas", "c2").boundingBox())!;
  const c1Box = (await row(page, "canvas", "c1").boundingBox())!;

  await page.mouse.move(c2Box.x + c2Box.width / 2, c2Box.y + c2Box.height / 2);
  await page.mouse.down();
  await page.mouse.move(c1Box.x + c1Box.width / 2, c1Box.y + 4, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => f.moves.length).toBe(1);
  expect(
    f.batchWrites().filter((entry) => entry.path.endsWith("/batch/move")),
  ).toHaveLength(0);

  // 已选行拖动：整组冻结并按当前可见顺序提交一次批量移动。
  await openFolder(page, "f1", "资料");
  await withKeys(page, ["Control"], () =>
    rowName(page, "canvas", "c1").click(),
  );
  await withKeys(page, ["Control"], () =>
    rowName(page, "canvas", "c2").click(),
  );
  const order = await page
    .locator("#directory-list > li[data-directory-key]")
    .evaluateAll((rows) =>
      rows
        .map((entry) => entry.getAttribute("data-directory-key")!)
        .filter((key) => key === "canvas:c1" || key === "canvas:c2"),
    );

  const from = (await row(page, "canvas", "c2").boundingBox())!;
  const to = (await row(page, "folder", "f3").boundingBox())!;

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
  const batchMove = f
    .batchWrites()
    .filter((entry) => entry.path.endsWith("/batch/move"));

  expect(batchMove).toHaveLength(1);
  expect(batchMove[0]!.body).toMatchObject({
    sources: order.map((key) => {
      const [kind, id] = key.split(":");

      return { kind, id };
    }),
    parentId: "f3",
  });
  expect(f.moves).toHaveLength(1);

  // 多项组拖入收藏被拒绝：只提示，不发收藏写请求。
  await withKeys(page, ["Control"], () =>
    rowName(page, "folder", "f1").click(),
  );
  await withKeys(page, ["Control"], () =>
    rowName(page, "folder", "f3").click(),
  );
  const group = (await row(page, "folder", "f3").boundingBox())!;
  const favorites = (await page.locator("[data-favorite-list]").boundingBox())!;

  await page.mouse.move(group.x + group.width / 2, group.y + group.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    favorites.x + favorites.width / 2,
    favorites.y + favorites.height / 2,
    { steps: 10 },
  );
  await expect(page.locator("[data-directory-drag-tooltip]")).toContainText(
    /我的文件/,
  );
  await page.mouse.up();
  expect(
    f.events.filter(
      (entry) => entry.method !== "GET" && entry.path.endsWith("/favorites"),
    ),
    "多项组不得提交任何收藏写请求",
  ).toHaveLength(0);
});

test("已选行右键是所选批量菜单，未选行先清选择再用单项菜单", async ({
  page,
  workspace,
}) => {
  await installDirectoryMock(page, workspace, { nodes: nodes() });
  await mountSidebar(page);
  await openFolder(page, "f1", "资料");
  await withKeys(page, ["Control"], () =>
    rowName(page, "folder", "f1").click(),
  );
  await withKeys(page, ["Control"], () =>
    rowName(page, "canvas", "c3").click(),
  );
  await row(page, "folder", "f1").click({ button: "right" });
  await expect(menu(page)).toContainText(/所选\s*2\s*项/);
  await expect(
    menu(page).getByRole("menuitem", { name: /移动到/, exact: false }),
  ).toBeVisible();
  await expect(
    menu(page).getByRole("menuitem", { name: /^移入回收站/ }),
  ).toBeVisible();
  await expect(
    menu(page).getByRole("menuitem", { name: /^取消选择/ }),
  ).toBeVisible();
  await expect(
    menu(page).getByRole("menuitem", { name: /^删除/, exact: false }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  // 右键未选行：清空选择，显示原单项菜单。
  await row(page, "canvas", "c2").click({ button: "right" });
  await expect(
    menu(page).getByRole("menuitem", { name: /^删除画布/ }),
  ).toBeVisible();
  await expect(menu(page)).not.toContainText(/所选\s*\d+\s*项/);
  await page.keyboard.press("Escape");
  await expectUnselected(row(page, "folder", "f1"));
  await expectUnselected(row(page, "canvas", "c3"));
});

test("批量删除先保存草稿、只关闭受影响标签、撤销一次恢复整组且不重开标签", async ({
  page,
  workspace,
}) => {
  const f = await installDirectoryMock(page, workspace, { nodes: nodes() });

  await mountSidebar(page);
  await openFolder(page, "f1", "资料");
  await rowName(page, "canvas", "c3").click();
  await expect(
    page.getByRole("tab", { name: "画布三", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await rowName(page, "canvas", "c1").click();
  await expect(
    page.getByRole("tab", { name: "画布一", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await rowName(page, "canvas", "c3").click();
  await drawRectangle(page);

  await withKeys(page, ["Control"], () =>
    rowName(page, "folder", "f1").click(),
  );
  await expectSelected(row(page, "folder", "f1"));
  await row(page, "folder", "f1").click({ button: "right" });
  await menu(page)
    .getByRole("menuitem", { name: /^移入回收站/ })
    .click();
  const dialog = page.getByRole("dialog", { name: "移入回收站", exact: true });

  // 菜单计数是原始选中行数，确认文案用服务端归一后的子树计数。
  await expect(dialog).toContainText(/2\s*个文件夹/);
  await expect(dialog).toContainText(/2\s*张画布/);
  await dialog.getByRole("button", { name: "移入回收站", exact: true }).click();

  await expect(row(page, "folder", "f1")).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "画布三", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "画布一", exact: true }),
  ).toHaveAttribute("aria-selected", "true");

  // 草稿必须在批删请求之前落盘。
  const put = f.events.findIndex(
    (entry) => entry.method === "PUT" && entry.path === "/api/canvases/c3",
  );
  const remove = f.events.findIndex((entry) =>
    entry.path.endsWith("/batch/delete"),
  );

  expect(put).toBeGreaterThanOrEqual(0);
  expect(put).toBeLessThan(remove);

  const undo = page.getByRole("button", { name: "撤销删除", exact: true });

  await expect(undo).toBeVisible();
  await undo.click();
  await expect(row(page, "folder", "f1")).toBeVisible();
  await expect(row(page, "canvas", "c3")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "画布三", exact: true }),
  ).toHaveCount(0);
  expect(
    f.batchWrites().filter((entry) => entry.path.endsWith("/batch/undo")),
  ).toHaveLength(1);
});

test("批量命令区分拒绝、未确认与已提交但刷新失败", async ({
  page,
  workspace,
}) => {
  const f = await installDirectoryMock(page, workspace, { nodes: nodes() });
  const deleteWrites = () =>
    f.batchWrites().filter((entry) => entry.path.endsWith("/batch/delete"));

  await mountSidebar(page);
  await rowName(page, "canvas", "c1").click();
  await expect(
    page.getByRole("tab", { name: "画布一", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await withKeys(page, ["Control"], () =>
    rowName(page, "canvas", "c2").click(),
  );

  // 明确 409 拒绝：等确认对话框（summary 已算完）出现后才注入，命中的是真正的写入。
  const confirm = page.getByRole("dialog", {
    name: "移入回收站",
    exact: true,
  });

  await row(page, "canvas", "c2").click({ button: "right" });
  await menu(page)
    .getByRole("menuitem", { name: /^移入回收站/ })
    .click();
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(/张画布/);
  f.failNextBatch(409, "CATALOG_CONFLICT", "目录已更新");
  await confirm
    .getByRole("button", { name: "移入回收站", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "目录已更新" }),
  ).toBeVisible();
  if (await confirm.count()) {
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
  }

  await expectSelected(row(page, "canvas", "c2"));
  await expect(row(page, "canvas", "c1")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "撤销删除", exact: true }),
  ).toHaveCount(0);
  expect(deleteWrites()).toHaveLength(1);

  // 响应丢失但服务端已提交：刷新核实，绝不重发写请求。
  f.dropNextBatchDelete();
  const readsBefore = f.reads.length;

  await row(page, "canvas", "c2").click({ button: "right" });
  await menu(page)
    .getByRole("menuitem", { name: /^移入回收站/ })
    .click();
  await page
    .getByRole("dialog", { name: "移入回收站", exact: true })
    .getByRole("button", { name: "移入回收站", exact: true })
    .click();
  await expect(row(page, "canvas", "c2")).toHaveCount(0);
  await expect.poll(() => f.reads.length).toBeGreaterThan(readsBefore);
  expect(deleteWrites()).toHaveLength(2);

  // 提交成功但刷新失败：提示视图过期、保留回执，不重复提交。
  // 用粘性失败，避免"删后自动选后继"或其它读取先把一次性标志消费掉造成假断言。
  f.failDirectoryReads();
  await withKeys(page, ["Control"], () =>
    rowName(page, "canvas", "c1").click(),
  );
  await row(page, "canvas", "c1").click({ button: "right" });
  await menu(page)
    .getByRole("menuitem", { name: /^移入回收站/ })
    .click();
  await expect(confirm).toBeVisible();
  await confirm
    .getByRole("button", { name: "移入回收站", exact: true })
    .click();
  const undo = page.getByRole("button", { name: "撤销删除", exact: true });

  await expect(undo).toBeVisible();
  expect(deleteWrites()).toHaveLength(3);

  // 回执先于刷新发布，必须等刷新确实失败后再解除故障。
  await expect(
    page.getByRole("alert").filter({ hasText: "本地目录同步失败" }),
  ).toBeVisible();
  // 恢复目录读取后，回执仍然有效：先刷新看到删除已生效，再撤销一次恢复。
  f.failDirectoryReads(false);
  await page.getByRole("button", { name: "重新加载目录", exact: true }).click();
  await expect(row(page, "canvas", "c1")).toHaveCount(0);
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(row(page, "canvas", "c1")).toBeVisible();
  expect(
    f.batchWrites().filter((entry) => entry.path.endsWith("/batch/undo")),
  ).toHaveLength(1);
});

test.describe("触屏显式多选", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("行菜单进入选择多个、轻触只切换、文件夹独立展开、零选项可退出", async ({
    page,
    workspace,
  }) => {
    await installDirectoryMock(page, workspace, { nodes: nodes() });
    await mountSidebar(page);

    const more = (label: string) =>
      page.getByRole("button", { name: label, exact: true });
    const exit = page.getByRole("button", { name: /^退出多选/ });

    await more("画布 画布一 的操作").tap();
    await menu(page)
      .getByRole("menuitem", { name: /^选择多个/ })
      .click();
    await expectSelected(row(page, "canvas", "c1"));
    await expect(exit).toBeVisible();

    // 轻触只切换选择，不打开画布。
    await rowName(page, "canvas", "c2").tap();
    await expectSelected(row(page, "canvas", "c2"));
    await expect(
      page.getByRole("tab", { name: "画布二", exact: true }),
    ).toHaveCount(0);

    // 文件夹用独立展开按钮，展开不清已有选择。
    await row(page, "folder", "f1").getByRole("button", { name: /展开/ }).tap();
    await expect(row(page, "canvas", "c3")).toBeVisible();
    await expectSelected(row(page, "canvas", "c2"));

    // Esc 有选项时只清集合、保留模式；零选项时再按 Esc 才退出。
    await page.keyboard.press("Escape");
    await expectUnselected(row(page, "canvas", "c1"));
    await expectUnselected(row(page, "canvas", "c2"));
    await expect(exit).toBeVisible();

    await rowName(page, "canvas", "c1").tap();
    await expectSelected(row(page, "canvas", "c1"));
    await rowName(page, "canvas", "c1").tap();
    await expectUnselected(row(page, "canvas", "c1"));
    await expect(exit).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(exit).toHaveCount(0);

    // 退出后普通轻触恢复打开画布。
    await rowName(page, "canvas", "c1").tap();
    await expect(
      page.getByRole("tab", { name: "画布一", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  });
});

test("收藏入口点击清树选择与锚点，收藏副本不参与框选", async ({
  page,
  workspace,
}) => {
  const f = await installDirectoryMock(page, workspace, { nodes: nodes() });

  await mountSidebar(page);
  await openFolder(page, "f1", "资料");
  await withKeys(page, ["Control"], () =>
    rowName(page, "canvas", "c3").click(),
  );
  await withKeys(page, ["Control"], () =>
    rowName(page, "canvas", "c1").click(),
  );
  await expectSelected(row(page, "canvas", "c3"));
  await expectSelected(row(page, "canvas", "c1"));

  await page
    .locator("[data-favorite-list] button.directory-name")
    .first()
    .click();
  await expectUnselected(row(page, "canvas", "c3"));
  await expectUnselected(row(page, "canvas", "c1"));

  // 锚点同时清空：随后 Shift 单击只选本行。
  await withKeys(page, ["Shift"], () => rowName(page, "canvas", "c2").click());
  await expectSelected(row(page, "canvas", "c2"));
  await expectUnselected(row(page, "canvas", "c3"));
  await expectUnselected(row(page, "canvas", "c1"));
  expect(f.opened.length).toBeGreaterThan(0);
});
