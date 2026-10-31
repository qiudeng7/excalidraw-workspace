// 真实 Chromium 运行新侧栏目录、编辑器和收藏列表；目录 HTTP 全部使用本文件替身。
// 保护展开不换画布、行内新建/重命名、收藏定位原树、移动对话框、递归删除/撤销及手机抽屉。
// 另保护整行拖拽（无六点柄）、folder 内部 into/行间 gap 排序、icon 槽对齐与 hover chevron、
// 手机原生滚动/轻触展开/长按起拖，以及固定移动状态、非法拖放 tooltip、active 行 CSS。
// 替身不证明数据库、权限或真实保存持久化。
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import type { CanvasDocument } from "../../shared/contracts";

type Node = {
  kind: "folder" | "canvas";
  id: string;
  name: string;
  parentId: string | null;
  position: number;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  canvas?: CanvasDocument;
};

type DeletedBatch = {
  id: string;
  parentId: string | null;
  nodes: Node[];
  affectedFolderIds: string[];
  affectedCanvasIds: string[];
};

const directoryFixture = async (
  page: Page,
  options: { extra?: number } = {},
) => {
  let revision = 0;
  let nextId = 0;
  const favorites: string[] = [];
  const batches: DeletedBatch[] = [];
  const writes: { method: string; path: string; body: unknown }[] = [];
  const reads: string[] = [];
  const now = "2026-10-12T00:00:00.000Z";
  const canvas = (id: string, name: string, parentId: string | null): Node => ({
    kind: "canvas",
    id,
    name,
    parentId,
    position: 0,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    canvas: {
      id,
      workspaceId: "test-space",
      name,
      revision: 0,
      position: 0,
      pinned: false,
      createdAt: now,
      updatedAt: now,
      scene: { elements: [], appState: {}, files: {} },
    },
  });
  const nodes: Node[] = [
    canvas("c1", "画布一", null),
    canvas("c2", "画布二", null),
    canvas("c3", "画布三", "f1"),
    canvas("c4", "画布四", "f2"),
    {
      kind: "folder",
      id: "f1",
      name: "资料",
      parentId: null,
      position: 1,
      favorite: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      kind: "folder",
      id: "f2",
      name: "子目录",
      parentId: "f1",
      position: 0,
      favorite: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      kind: "folder",
      id: "f3",
      name: "深层目标",
      parentId: null,
      position: 0,
      favorite: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      kind: "folder",
      id: "f4",
      name: "二级",
      parentId: "f3",
      position: 0,
      favorite: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      kind: "folder",
      id: "f5",
      name: "三级",
      parentId: "f4",
      position: 0,
      favorite: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      kind: "folder",
      id: "f6",
      name: "四级",
      parentId: "f5",
      position: 0,
      favorite: false,
      createdAt: now,
      updatedAt: now,
    },
  ];

  for (let index = 0; index < (options.extra ?? 0); index++)
    nodes.push(canvas(`extra-${index}`, `附加画布 ${index + 1}`, null));

  for (const parentId of [null, "f1", "f2", "f3", "f4", "f5"]) {
    let position = 0;

    for (const node of nodes)
      if (node.parentId === parentId) node.position = position++;
  }

  const children = (parentId: string | null) =>
    nodes
      .filter((node) => node.parentId === parentId)
      .sort(
        (a, b) =>
          a.position - b.position ||
          a.id.localeCompare(b.id) ||
          a.kind.localeCompare(b.kind),
      );
  const find = (id: string) => nodes.find((node) => node.id === id);
  const depth = (node: Node) => {
    let value = 1;
    let parent = node.parentId ? find(node.parentId) : undefined;

    while (parent) {
      value++;
      parent = parent.parentId ? find(parent.parentId) : undefined;
    }

    return value;
  };
  const subtreeDepth = (node: Node): number => {
    if (node.kind !== "folder") return 0;
    const folders = children(node.id).filter(
      (entry) => entry.kind === "folder",
    );

    return 1 + (folders.length ? Math.max(...folders.map(subtreeDepth)) : 0);
  };
  const subtree = (id: string): Node[] => {
    const result: Node[] = [];
    const visit = (current: string) => {
      const node = find(current);

      if (!node) return;
      result.push(node);
      for (const child of nodes.filter((entry) => entry.parentId === current))
        visit(child.id);
    };

    visit(id);

    return result;
  };
  const serialize = (node: Node) => ({
    kind: node.kind,
    id: node.id,
    workspaceId: "test-space",
    parentId: node.parentId,
    name: node.name,
    position: node.position,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    favorite: favorites.includes(node.id),
    ...(node.kind === "folder"
      ? {
          depth: depth(node),
          childCount: children(node.id).length,
          subtreeDepth: subtreeDepth(node),
        }
      : { canvas: node.canvas }),
  });
  const pageFor = (parentId: string | null) => {
    const items = children(parentId);

    return {
      parentId,
      items: items.map(serialize),
      total: items.length,
      nextCursor: null,
      catalogRevision: revision,
      hasPrevious: false,
    };
  };
  const pathFor = (node: Node) => {
    const chain: Node[] = [];

    let current: Node | undefined = node;

    while (current) {
      chain.unshift(current);
      current = current.parentId ? find(current.parentId) : undefined;
    }

    const ancestors = chain.slice(0, -1);
    const pages = chain.map((pathNode) => {
      const parentId = pathNode.parentId;
      const siblings = children(parentId);
      const start = siblings.findIndex((entry) => entry.id === pathNode.id);

      return {
        ...pageFor(parentId),
        items: siblings.slice(start).map(serialize),
        hasPrevious: start > 0,
      };
    });

    return {
      ancestors: ancestors.map(serialize),
      item: serialize(node),
      catalogRevision: revision,
      pages,
    };
  };
  const addToFavorites = (node: Node, value: boolean) => {
    const index = favorites.indexOf(node.id);

    if (value && index < 0) favorites.push(node.id);
    if (!value && index >= 0) favorites.splice(index, 1);
  };
  const removeSubtree = (node: Node) => {
    const removed = subtree(node.id);

    for (const entry of removed) {
      const index = nodes.indexOf(entry);

      if (index >= 0) nodes.splice(index, 1);
      addToFavorites(entry, false);
    }

    return removed;
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const query = new URL(request.url()).searchParams;
    const method = request.method();
    const body = method === "GET" ? undefined : (request.postDataJSON() as any);

    if (method !== "GET") writes.push({ method, path, body });
    else reads.push(path);

    if (path === "/api/navigation") {
      return route.fulfill({
        json: {
          revision,
          lastWorkspaceId: "test-space",
          lastCanvasId: "c1",
          workspaces: [{ workspaceId: "test-space", lastCanvasId: "c1" }],
        },
      });
    }

    if (path === "/api/workspaces/test-space/canvases" && method === "GET") {
      return route.fulfill({
        json: {
          canvases: nodes
            .filter((node) => node.kind === "canvas")
            .map((node) => node.canvas),
          catalogRevision: revision,
          total: nodes.filter((node) => node.kind === "canvas").length,
          nextCursor: null,
        },
      });
    }

    if (path === "/api/workspaces/test-space/directory") {
      const parentId = query.get("parentId");

      return route.fulfill({ json: pageFor(parentId || null) });
    }

    if (path === "/api/workspaces/test-space/directory/path") {
      const node = find(query.get("id") ?? "");

      if (!node || node.kind !== query.get("kind"))
        return route.fulfill({
          status: 404,
          json: { error: { code: "NOT_FOUND", message: "目录项目不存在" } },
        });

      return route.fulfill({ json: pathFor(node) });
    }

    if (path === "/api/workspaces/test-space/favorites") {
      if (method === "GET")
        return route.fulfill({
          json: {
            items: favorites
              .map((id) => find(id))
              .filter((node): node is Node => !!node)
              .map(serialize),
            catalogRevision: revision,
          },
        });

      const node = find(body.source.id);

      if (!node)
        return route.fulfill({
          status: 404,
          json: { error: { code: "NOT_FOUND", message: "目录项目不存在" } },
        });
      if (body.catalogRevision !== revision)
        return route.fulfill({
          status: 409,
          json: {
            error: { code: "CATALOG_CONFLICT", message: "目录已更新" },
          },
        });

      addToFavorites(node, body.favorite);
      revision++;

      return route.fulfill({
        json: { item: serialize(node), catalogRevision: revision },
      });
    }

    if (path === "/api/workspaces/test-space/favorites/order") {
      if (body.catalogRevision !== revision)
        return route.fulfill({
          status: 409,
          json: {
            error: { code: "CATALOG_CONFLICT", message: "目录已更新" },
          },
        });

      const source = favorites.indexOf(body.source.id);
      const target = favorites.indexOf(body.target.id);

      if (source >= 0 && target >= 0) {
        favorites.splice(source, 1);
        favorites.splice(
          favorites.indexOf(body.target.id) +
            (body.placement === "after" ? 1 : 0),
          0,
          body.source.id,
        );
      }

      revision++;

      return route.fulfill({ json: { catalogRevision: revision } });
    }

    if (path === "/api/workspaces/test-space/folders" && method === "POST") {
      if (body.catalogRevision !== revision)
        return route.fulfill({
          status: 409,
          json: {
            error: { code: "CATALOG_CONFLICT", message: "目录已更新" },
          },
        });

      const parent = body.parentId ? find(body.parentId) : undefined;

      if (body.parentId && (!parent || parent.kind !== "folder"))
        return route.fulfill({
          status: 404,
          json: { error: { code: "NOT_FOUND", message: "父文件夹不存在" } },
        });

      const node: Node = {
        kind: "folder",
        id: `f-new-${++nextId}`,
        name: body.name,
        parentId: body.parentId ?? null,
        position: children(body.parentId ?? null).length,
        favorite: false,
        createdAt: now,
        updatedAt: now,
      };

      nodes.push(node);
      revision++;

      return route.fulfill({
        json: { item: serialize(node), catalogRevision: revision },
      });
    }

    if (path === "/api/workspaces/test-space/canvases" && method === "POST") {
      if (body.catalogRevision !== revision)
        return route.fulfill({
          status: 409,
          json: {
            error: { code: "CATALOG_CONFLICT", message: "目录已更新" },
          },
        });

      const node = canvas(
        `c-new-${++nextId}`,
        body.name,
        body.parentId ?? null,
      );

      node.position = children(body.parentId ?? null).length;
      nodes.push(node);
      revision++;

      return route.fulfill({
        json: { canvas: node.canvas, catalogRevision: revision },
      });
    }

    const folderPath = path.match(/^\/api\/folders\/([^/]+)$/);

    if (folderPath) {
      const node = find(folderPath[1]!);

      if (!node || node.kind !== "folder")
        return route.fulfill({
          status: 404,
          json: { error: { code: "NOT_FOUND", message: "文件夹不存在" } },
        });
      if (method === "PATCH") {
        if (body.catalogRevision !== revision)
          return route.fulfill({
            status: 409,
            json: {
              error: { code: "CATALOG_CONFLICT", message: "目录已更新" },
            },
          });

        node.name = body.name;
        node.updatedAt = now;
        revision++;

        return route.fulfill({
          json: { item: serialize(node), catalogRevision: revision },
        });
      }

      if (method === "DELETE") {
        if (body.catalogRevision !== revision)
          return route.fulfill({
            status: 409,
            json: {
              error: { code: "CATALOG_CONFLICT", message: "目录已更新" },
            },
          });

        const removed = removeSubtree(node);
        const batch: DeletedBatch = {
          id: node.id,
          parentId: node.parentId,
          nodes: removed,
          affectedFolderIds: removed
            .filter((entry) => entry.kind === "folder")
            .map((entry) => entry.id),
          affectedCanvasIds: removed
            .filter((entry) => entry.kind === "canvas")
            .map((entry) => entry.id),
        };

        batches.push(batch);
        revision++;

        return route.fulfill({
          json: {
            catalogRevision: revision,
            affectedFolderIds: batch.affectedFolderIds,
            affectedCanvasIds: batch.affectedCanvasIds,
          },
        });
      }
    }

    const summaryPath = path.match(/^\/api\/folders\/([^/]+)\/summary$/);

    if (summaryPath) {
      const node = find(summaryPath[1]!);

      if (!node) return route.fallback();
      const descendants = subtree(node.id).slice(1);

      return route.fulfill({
        json: {
          folderCount: descendants.filter((entry) => entry.kind === "folder")
            .length,
          canvasCount: descendants.filter((entry) => entry.kind === "canvas")
            .length,
          catalogRevision: revision,
        },
      });
    }

    if (path === "/api/workspaces/test-space/directory/move") {
      if (body.catalogRevision !== revision)
        return route.fulfill({
          status: 409,
          json: {
            error: { code: "CATALOG_CONFLICT", message: "目录已更新" },
          },
        });

      const source = find(body.source.id);

      if (!source) return route.fallback();
      const siblings = children(body.parentId ?? null);

      if (body.target) {
        const target = find(body.target.id);

        if (
          !target ||
          target.parentId !== (body.parentId ?? null) ||
          siblings.indexOf(target) < 0
        )
          return route.fulfill({
            status: 400,
            json: {
              error: {
                code: "INVALID_DIRECTORY_MOVE",
                message: "目标不是直接子项",
              },
            },
          });
      }

      source.parentId = body.parentId ?? null;
      const ordered = children(source.parentId).filter(
        (entry) => entry.id !== source.id,
      );
      const targetIndex = body.target
        ? ordered.findIndex((entry) => entry.id === body.target.id)
        : ordered.length;

      ordered.splice(
        targetIndex < 0
          ? ordered.length
          : targetIndex + (body.placement === "after" ? 1 : 0),
        0,
        source,
      );
      ordered.forEach((entry, index) => {
        entry.position = index;
      });
      revision++;

      return route.fulfill({ json: { catalogRevision: revision } });
    }

    const recyclePath = path.match(/^\/api\/recycle-bin\/folder\/([^/]+)$/);

    if (recyclePath) {
      const batch = batches.find((entry) => entry.id === recyclePath[1]);

      if (!batch) return route.fallback();
      if (method === "DELETE") {
        batches.splice(batches.indexOf(batch), 1);

        return route.fulfill({ json: {} });
      }

      if (method === "POST") {
        const requested = body?.parentId;

        if (requested !== undefined && requested !== null && !find(requested))
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: "RESTORE_LOCATION_REQUIRED",
                message: "请选择恢复位置",
              },
            },
          });
        batch.nodes.forEach((node) => {
          node.parentId =
            node.id === batch.id
              ? (requested ?? batch.parentId)
              : node.parentId;
          nodes.push(node);
        });
        batches.splice(batches.indexOf(batch), 1);
        revision++;

        return route.fulfill({
          json: {
            catalogRevision: revision,
            restoredFolderIds: batch.affectedFolderIds,
            restoredCanvasIds: batch.affectedCanvasIds,
          },
        });
      }
    }

    if (path === "/api/recycle-bin") {
      return route.fulfill({ json: { entries: [] } });
    }

    const canvasPath = path.match(/^\/api\/canvases\/([^/]+)$/);

    if (canvasPath) {
      const node = find(canvasPath[1]!);

      if (!node || node.kind !== "canvas") return route.fallback();
      if (method === "GET") {
        reads.push(`canvas:${node.id}`);

        return route.fulfill({ json: { canvas: node.canvas } });
      }

      if (method === "PUT") {
        node.canvas!.scene = body.scene;

        return route.fulfill({
          json: {
            revision: ++node.canvas!.revision,
            updatedAt: now,
          },
        });
      }
    }

    return route.fallback();
  });

  await page.reload();

  const sidebarToggle = page.getByRole("button", {
    name: "切换工作空间侧边栏",
    exact: true,
  });

  await expect(sidebarToggle).toBeVisible();
  if ((await sidebarToggle.getAttribute("aria-expanded")) === "false")
    await sidebarToggle.click();
  await expect(
    page.getByRole("list", { name: "我的文件", exact: true }),
  ).toBeVisible();

  return {
    writes,
    reads,
    revision: () => revision,
    node: find,
    path: async (kind: "canvas" | "folder", id: string) =>
      page.evaluate(
        async ({ kind, id }) =>
          (
            await fetch(
              `/api/workspaces/test-space/directory/path?kind=${kind}&id=${id}`,
            )
          ).json(),
        { kind, id },
      ),
    children,
    addToFavorites: (id: string) => {
      const node = find(id);

      if (node) addToFavorites(node, true);
    },
  };
};

const treeRow = (page: Page, kind: "folder" | "canvas", id: string) =>
  page.locator(`#directory-list [data-directory-key="${kind}:${id}"]`);
const folderName = (page: Page, name: string) =>
  treeRow(page, "folder", "f1").getByRole("button", { name, exact: true });
const more = (page: Page, label: string) =>
  page.getByRole("button", { name: label, exact: true });
const menu = (page: Page, label: string) =>
  page.getByRole("menu", { name: label, exact: true });

test("单击文件夹只展开、不替换当前画布，画布单击才打开", async ({
  page,
  workspace: _workspace,
}, testInfo) => {
  const f = await directoryFixture(page);

  await expect(page.locator("#directory-list .drag-handle")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^在文件夹 .* 中新建$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "文件夹 资料 的操作", exact: true }),
  ).toBeVisible();
  const moreIcon = treeRow(page, "canvas", "c2").locator(
    "[data-sidebar-more-icon]",
  );
  const moreBox = (await moreIcon.boundingBox())!;
  const dots = moreIcon.locator("circle");

  expect(moreBox.width).toBeGreaterThanOrEqual(16);
  expect(moreBox.height).toBeGreaterThanOrEqual(16);
  await expect(dots).toHaveCount(3);
  expect(
    await dots.evaluateAll((circles) =>
      circles.every((circle) => {
        const style = getComputedStyle(circle);

        return style.fill !== "none" && Number(style.opacity) > 0;
      }),
    ),
  ).toBe(true);
  const activeRow = treeRow(page, "canvas", "c1");
  const activeStyle = await activeRow.evaluate((element) => {
    const style = getComputedStyle(element);

    return {
      background: style.backgroundColor,
      borderLeftWidth: style.borderLeftWidth,
      boxShadow: style.boxShadow,
    };
  });
  const plainBackground = await treeRow(page, "folder", "f1").evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );

  expect(activeStyle.borderLeftWidth).toBe("0px");
  expect(activeStyle.boxShadow).toBe("none");
  expect(activeStyle.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(activeStyle.background).not.toBe(plainBackground);
  const activeName = activeRow.getByRole("button", {
    name: "画布一",
    exact: true,
  });

  await activeName.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(activeName).toBeFocused();
  const focusStyle = await activeName.evaluate((element) => {
    const style = getComputedStyle(element);

    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });

  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(focusStyle.outlineWidth).toBeGreaterThan(0);

  const folderSlot = treeRow(page, "folder", "f1").locator("[data-node-icon]");
  const canvasSlot = treeRow(page, "canvas", "c2").locator("[data-node-icon]");
  const folderBox = (await folderSlot.boundingBox())!;
  const canvasBox = (await canvasSlot.boundingBox())!;

  await expect(folderSlot).toHaveAttribute("data-icon-kind", "folder");
  await expect(canvasSlot).toHaveAttribute("data-icon-kind", "canvas");
  expect(Math.abs(folderBox.x - canvasBox.x)).toBeLessThan(0.5);
  expect(folderBox.width).toBeCloseTo(15, 0);
  expect(folderBox.height).toBeCloseTo(15, 0);
  expect(canvasBox.width).toBeCloseTo(15, 0);
  const symbol = folderSlot.locator(".folder-symbol");
  const chevron = folderSlot.locator(".folder-chevron");
  const shown = (locator: typeof symbol) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0
      );
    });

  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.mouse.move(400, 100);
  await expect.poll(() => shown(symbol)).toBe(true);
  await expect.poll(() => shown(chevron)).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("sidebar-icons-default.png"),
  });
  await treeRow(page, "folder", "f1").hover();
  await expect.poll(() => shown(symbol)).toBe(false);
  await expect.poll(() => shown(chevron)).toBe(true);
  const hoveredBox = (await folderSlot.boundingBox())!;

  expect(hoveredBox.x).toBeCloseTo(folderBox.x, 0);
  expect(hoveredBox.y).toBeCloseTo(folderBox.y, 0);
  expect(hoveredBox.width).toBeCloseTo(folderBox.width, 0);
  await page.screenshot({
    path: testInfo.outputPath("sidebar-icons-hover.png"),
  });
  await testInfo.attach("侧栏同级 icon 默认", {
    path: testInfo.outputPath("sidebar-icons-default.png"),
    contentType: "image/png",
  });
  await testInfo.attach("侧栏 folder hover chevron", {
    path: testInfo.outputPath("sidebar-icons-hover.png"),
    contentType: "image/png",
  });
  await expect(treeRow(page, "folder", "f2")).toHaveCount(0);
  await folderName(page, "资料").click();
  await expect(folderName(page, "资料")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(treeRow(page, "canvas", "c3")).toBeVisible();
  await page.mouse.move(400, 100);
  await expect.poll(() => shown(symbol)).toBe(true);
  await expect.poll(() => shown(chevron)).toBe(false);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(folderName(page, "资料")).toBeFocused();
  await expect.poll(() => shown(chevron)).toBe(true);
  await expect(
    page.getByRole("tab", { name: "画布一", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(f.reads.filter((entry) => entry === "canvas:c2")).toHaveLength(0);

  await treeRow(page, "canvas", "c2")
    .getByRole("button", { name: "画布二", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "画布二", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("浅色与深色侧栏使用中性灰，选中背景与普通行区分且省略号保持实心", async ({
  page,
  workspace: _workspace,
}, testInfo) => {
  await directoryFixture(page);
  const parse = (color: string) => {
    const values = color.match(/[\d.]+/g)?.map(Number) ?? [];

    return {
      red: values[0] ?? 0,
      green: values[1] ?? 0,
      blue: values[2] ?? 0,
      alpha: values[3] ?? 1,
    };
  };
  const neutral = (color: string) => {
    const { red, green, blue } = parse(color);

    return Math.max(red, green, blue) - Math.min(red, green, blue) <= 4;
  };
  const luminance = (color: string) => {
    const { red, green, blue } = parse(color);
    const channel = (value: number) => {
      const normalized = value / 255;

      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };

    return (
      0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
    );
  };
  const contrast = (first: string, second: string) => {
    const values = [luminance(first), luminance(second)].sort((a, b) => b - a);

    return (values[0]! + 0.05) / (values[1]! + 0.05);
  };
  const read = () =>
    page.evaluate(() => {
      const color = (selector: string, property: string) => {
        const element = document.querySelector(selector);

        return element
          ? getComputedStyle(element).getPropertyValue(property)
          : "";
      };
      const row = document.querySelector(
        '#directory-list [data-directory-key="canvas:c1"]',
      )!;
      const normal = document.querySelector(
        '#directory-list [data-directory-key="canvas:c2"]',
      )!;
      const icon = row.querySelector("[data-node-icon] svg")!;
      const dots = row.querySelector("[data-sidebar-more-icon] circle")!;

      return {
        surface: color(".workspace-sidebar", "background-color"),
        selectedBackground: getComputedStyle(row).backgroundColor,
        normalBackground: getComputedStyle(normal).backgroundColor,
        selectedText: getComputedStyle(row).color,
        icon: getComputedStyle(icon).color,
        dots: getComputedStyle(dots).fill,
        dotCount: row.querySelectorAll("[data-sidebar-more-icon] circle")
          .length,
        dotBox: (() => {
          const box = (
            row.querySelector("[data-sidebar-more-icon]") as SVGElement
          ).getBoundingClientRect();

          return { width: box.width, height: box.height };
        })(),
      };
    });

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const colors = await read();

    expect(neutral(colors.surface)).toBe(true);
    expect(neutral(colors.selectedBackground)).toBe(true);
    expect(neutral(colors.icon)).toBe(true);
    expect(neutral(colors.dots)).toBe(true);
    expect(colors.selectedBackground).not.toBe(colors.normalBackground);
    expect(parse(colors.selectedBackground).alpha).toBeGreaterThan(0);
    if (theme === "light")
      expect(luminance(colors.surface)).toBeGreaterThan(0.7);
    else expect(luminance(colors.surface)).toBeLessThan(0.3);
    expect(colors.icon).not.toBe(colors.selectedText);
    expect(colors.dots).not.toBe(colors.selectedText);
    expect(contrast(colors.icon, colors.selectedBackground)).toBeLessThan(
      contrast(colors.selectedText, colors.selectedBackground),
    );
    expect(contrast(colors.dots, colors.selectedBackground)).toBeLessThan(
      contrast(colors.selectedText, colors.selectedBackground),
    );
    expect(colors.dotCount).toBe(3);
    expect(colors.dots).not.toBe("none");
    expect(colors.dotBox.width).toBeGreaterThanOrEqual(16);
    await page.screenshot({
      path: testInfo.outputPath(`sidebar-theme-${theme}.png`),
    });
    await testInfo.attach(`侧栏 ${theme} 中性配色`, {
      path: testInfo.outputPath(`sidebar-theme-${theme}.png`),
      contentType: "image/png",
    });
  }
});

test("新建与重命名使用行内输入，Enter 提交、Esc 取消", async ({
  page,
  workspace: _workspace,
}) => {
  const f = await directoryFixture(page);

  await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
  const create = page.getByRole("textbox", {
    name: "新建文件夹名称",
    exact: true,
  });

  await create.fill("新资料");
  await create.press("Escape");
  await expect(create).toBeHidden();
  expect(
    f.writes.some(
      (entry) => entry.path === "/api/workspaces/test-space/folders",
    ),
  ).toBe(false);

  await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
  await page
    .getByRole("textbox", { name: "新建文件夹名称", exact: true })
    .fill("新资料");
  await page
    .getByRole("textbox", { name: "新建文件夹名称", exact: true })
    .press("Enter");
  await expect(
    page.getByRole("button", { name: "新资料", exact: true }),
  ).toBeVisible();

  await more(page, "文件夹 资料 的操作").click();
  await menu(page, "文件夹 资料 的操作")
    .getByRole("menuitem", { name: "重命名", exact: true })
    .click();
  const rename = page.getByRole("textbox", {
    name: "重命名文件夹名称",
    exact: true,
  });

  await rename.fill("设计资料");
  await rename.press("Escape");
  await expect(
    page.getByRole("button", { name: "资料", exact: true }),
  ).toBeVisible();

  await more(page, "文件夹 资料 的操作").click();
  await menu(page, "文件夹 资料 的操作")
    .getByRole("menuitem", { name: "重命名", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "重命名文件夹名称", exact: true })
    .fill("设计资料");
  await page
    .getByRole("textbox", { name: "重命名文件夹名称", exact: true })
    .press("Enter");
  await expect(
    page.getByRole("button", { name: "设计资料", exact: true }),
  ).toBeVisible();
});

test("收藏是独立列表，定位原位置会展开祖先但保持当前画布", async ({
  page,
  workspace: _workspace,
}) => {
  const f = await directoryFixture(page);

  f.addToFavorites("c4");
  await page.reload();
  const toggle = page.getByRole("button", {
    name: "切换工作空间侧边栏",
    exact: true,
  });

  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await expect(
    page.getByRole("list", { name: "收藏", exact: true }).getByText("画布四", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.locator('[data-directory-key="folder:f1"]').getByRole("button", {
      name: "资料",
      exact: true,
    }),
  ).toHaveAttribute("aria-expanded", "false");
  const active = page.locator('[role="tab"][aria-selected="true"]');

  await expect(active).toContainText("画布一");
  await more(page, "收藏 画布四 的操作").click();
  await menu(page, "画布 画布四 的操作")
    .getByRole("menuitem", { name: "定位原位置", exact: true })
    .click();
  await expect(folderName(page, "资料")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    page
      .locator('[data-directory-key="folder:f2"]')
      .getByRole("button", { name: "子目录", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(treeRow(page, "canvas", "c4")).toBeVisible();
  await expect(active).toContainText("画布一");
});

test("移动对话框把画布移入文件夹，确认前不提交", async ({
  page,
  workspace: _workspace,
}, testInfo) => {
  const f = await directoryFixture(page, { extra: 15 });

  await more(page, "画布 画布二 的操作").click();
  await menu(page, "画布 画布二 的操作")
    .getByRole("menuitem", { name: "移动到…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "移动到", exact: true });

  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "打开目标文件夹 资料", exact: true })
    .click();
  await dialog.getByRole("button", { name: "移动到这里", exact: true }).click();
  await expect(folderName(page, "资料")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(treeRow(page, "canvas", "c2")).toBeVisible();
  const moved = f.writes.find(
    (entry) => entry.path === "/api/workspaces/test-space/directory/move",
  );

  expect(moved?.body).toMatchObject({
    source: { kind: "canvas", id: "c2" },
    parentId: "f1",
    placement: "end",
  });
  const path = await f.path("canvas", "c2");

  expect(path.ancestors).toHaveLength(1);
  expect(path.pages).toHaveLength(2);
  expect(path.pages[1]).toMatchObject({ parentId: "f1" });
  expect(path.pages[1].items[0]).toMatchObject({ id: "c2" });

  const status = page.getByRole("status").filter({ hasText: "已移动" });

  await expect(status).toBeVisible();
  const statusBox = (await status.boundingBox())!;
  const recycle = (await page
    .getByRole("button", { name: "回收站", exact: true })
    .boundingBox())!;

  expect(await status.evaluate((el) => !el.closest(".sidebar-scroll"))).toBe(
    true,
  );
  expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(recycle.y + 1);
  await page
    .locator(".sidebar-scroll")
    .evaluate((element) => (element.scrollTop = element.scrollHeight));
  await expect
    .poll(async () => (await status.boundingBox())?.y ?? -1)
    .toBeCloseTo(statusBox.y, 0);
  await page.screenshot({
    path: testInfo.outputPath("sidebar-move-status.png"),
  });
  await testInfo.attach("移动状态固定在回收站上方", {
    path: testInfo.outputPath("sidebar-move-status.png"),
    contentType: "image/png",
  });
  await status.getByRole("button", { name: "撤销移动", exact: true }).click();
  await expect(status).toBeHidden();
  await expect
    .poll(
      () =>
        f.writes.filter(
          (entry) => entry.path === "/api/workspaces/test-space/directory/move",
        ).length,
    )
    .toBe(2);
  const undo = f.writes
    .filter(
      (entry) => entry.path === "/api/workspaces/test-space/directory/move",
    )
    .at(-1);

  expect(undo?.body).toMatchObject({
    source: { kind: "canvas", id: "c2" },
    parentId: null,
    target: { kind: "folder", id: "f1" },
    placement: "before",
  });
  expect((await f.path("canvas", "c2")).ancestors).toHaveLength(0);
});

test("删除文件夹确认递归数量，关闭已打开子画布并撤销恢复整组", async ({
  page,
  workspace: _workspace,
}) => {
  await directoryFixture(page);
  await folderName(page, "资料").click();
  await treeRow(page, "folder", "f2")
    .getByRole("button", { name: "子目录", exact: true })
    .click();
  await treeRow(page, "canvas", "c3")
    .getByRole("button", { name: "画布三", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "画布三", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await more(page, "文件夹 资料 的操作").click();
  await menu(page, "文件夹 资料 的操作")
    .getByRole("menuitem", { name: "删除文件夹", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "移入回收站", exact: true });

  await expect(dialog).toContainText(/1\s*个文件夹/);
  await expect(dialog).toContainText(/2\s*张画布/);
  await dialog.getByRole("button", { name: "移入回收站", exact: true }).click();
  await expect(treeRow(page, "folder", "f1")).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "画布三", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "撤销删除", exact: true }).click();
  await expect(treeRow(page, "folder", "f1")).toBeVisible();
  await expect(treeRow(page, "canvas", "c3")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "画布三", exact: true }),
  ).toHaveCount(0);
});

test("移动对话框在提交前禁用会让两层子树超过五层的目标", async ({
  page,
  workspace: _workspace,
}) => {
  const f = await directoryFixture(page);

  await more(page, "文件夹 资料 的操作").click();
  await menu(page, "文件夹 资料 的操作")
    .getByRole("menuitem", { name: "移动到…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "移动到", exact: true });

  await dialog
    .getByRole("button", { name: "打开目标文件夹 深层目标", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "打开目标文件夹 二级", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "打开目标文件夹 三级", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "打开目标文件夹 四级", exact: true }),
  ).toBeDisabled();
  expect(
    f.writes.some(
      (entry) => entry.path === "/api/workspaces/test-space/directory/move",
    ),
  ).toBe(false);
});

test("真实指针拖拽在行间生成插入线并提交同父排序", async ({
  page,
  workspace: _workspace,
}) => {
  const f = await directoryFixture(page);
  const source = (await treeRow(page, "canvas", "c2").boundingBox())!;
  const target = (await treeRow(page, "canvas", "c1").boundingBox())!;

  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + 4, {
    steps: 8,
  });
  await expect(treeRow(page, "canvas", "c1")).toHaveClass(/drop-before/);
  await page.mouse.up();
  await expect
    .poll(() =>
      page
        .locator("#directory-list > li[data-directory-key]")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-directory-key")),
        ),
    )
    .toEqual(["canvas:c2", "canvas:c1", "folder:f1", "folder:f3"]);
  const moved = f.writes.find(
    (entry) => entry.path === "/api/workspaces/test-space/directory/move",
  );

  expect(moved?.body).toMatchObject({
    source: { kind: "canvas", id: "c2" },
    parentId: null,
    target: { kind: "canvas", id: "c1" },
    placement: "before",
  });
  await expect(
    page.getByRole("tab", { name: "画布一", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 文件夹行内部是 into；边界排序必须落在相邻行间的 4px gap 中点。
  const folder = await treeRow(page, "folder", "f3").boundingBox();
  const above = await treeRow(page, "canvas", "c1").boundingBox();
  const below = await treeRow(page, "folder", "f1").boundingBox();
  const gapY = (above!.y + above!.height + below!.y) / 2;

  await page.mouse.move(
    folder!.x + folder!.width / 2,
    folder!.y + folder!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(folder!.x + folder!.width / 2, gapY, { steps: 8 });
  await expect(treeRow(page, "folder", "f1")).toHaveClass(/drop-before/);
  await page.mouse.up();
  const reordered = f.writes
    .filter(
      (entry) => entry.path === "/api/workspaces/test-space/directory/move",
    )
    .at(-1);

  expect(reordered?.body).toMatchObject({
    source: { kind: "folder", id: "f3" },
    parentId: null,
    target: { kind: "folder", id: "f1" },
    placement: "before",
  });
  await expect
    .poll(() =>
      page
        .locator("#directory-list > li[data-directory-key]")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-directory-key")),
        ),
    )
    .toEqual(["canvas:c2", "canvas:c1", "folder:f3", "folder:f1"]);
});

test("拖入文件夹时悬停展开，Esc 取消不提交，再次拖入才移动", async ({
  page,
  workspace: _workspace,
}) => {
  const f = await directoryFixture(page);
  const source = (await treeRow(page, "canvas", "c2").boundingBox())!;
  const folder = (await treeRow(page, "folder", "f1").boundingBox())!;

  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    folder.x + folder.width / 2,
    folder.y + folder.height / 2,
  );
  await expect(treeRow(page, "folder", "f1")).toHaveClass(/drop-inside/);
  await page.waitForTimeout(700);
  await expect(folderName(page, "资料")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(
    f.writes.some(
      (entry) => entry.path === "/api/workspaces/test-space/directory/move",
    ),
  ).toBe(false);
  await expect(treeRow(page, "canvas", "c2")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "画布一", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[role="menu"]')).toHaveCount(0);

  const again = (await treeRow(page, "canvas", "c2").boundingBox())!;
  const destination = (await treeRow(page, "folder", "f1").boundingBox())!;

  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    destination.x + destination.width / 2,
    destination.y + destination.height / 2,
  );
  await page.mouse.up();
  await expect(treeRow(page, "canvas", "c2")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "画布一", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  const moved = f.writes.find(
    (entry) => entry.path === "/api/workspaces/test-space/directory/move",
  );

  expect(moved?.body).toMatchObject({
    source: { kind: "canvas", id: "c2" },
    parentId: "f1",
    placement: "end",
  });
  const path = await f.path("canvas", "c2");

  expect(path.ancestors).toHaveLength(1);
  expect(path.pages).toHaveLength(2);
  expect(path.pages[1]).toMatchObject({ parentId: "f1" });
  expect(path.pages[1].items[0]).toMatchObject({ id: "c2" });
});

test("非法拖放只显示贴近指针的 tooltip，不占行间且 Esc 消失不提交", async ({
  page,
  workspace: _workspace,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 400 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const f = await directoryFixture(page, { extra: 4 });
  const tip = page.locator('[data-directory-drag-tooltip][role="tooltip"]');
  const row = treeRow(page, "canvas", "c2");

  // 测布局稳定性时避开边缘自动滚动区，避免把滚动误判为 tooltip 占位。
  await row.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const before = (await row.boundingBox())!;

  await page.mouse.move(
    before.x + before.width / 2,
    before.y + before.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    before.x + before.width / 2 + 8,
    before.y + before.height / 2,
    { steps: 4 },
  );
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(/自身|子文件夹/);
  const describedBy = await row
    .getByRole("button", { name: "画布二", exact: true })
    .getAttribute("aria-describedby");

  expect(describedBy).toBeTruthy();
  expect(await tip.getAttribute("id")).toBe(describedBy);
  const box = (await tip.boundingBox())!;

  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390.5);
  expect(box.y + box.height).toBeLessThanOrEqual(400.5);
  expect(await tip.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe(
    "none",
  );
  expect(await tip.evaluate((el) => getComputedStyle(el).position)).toBe(
    "fixed",
  );
  expect(
    await tip.evaluate(
      (el) => !el.closest("#directory-list") && !el.closest(".sidebar-scroll"),
    ),
  ).toBe(true);
  const durations = await tip.evaluate((el) => {
    const style = getComputedStyle(el);

    return `${style.transitionDuration},${style.animationDuration}`
      .split(",")
      .map((duration) => duration.trim())
      .filter(Boolean);
  });

  expect(durations.every((duration) => Number.parseFloat(duration) === 0)).toBe(
    true,
  );
  const after = (await row.boundingBox())!;

  expect(after.y).toBeCloseTo(before.y, 0);
  expect(after.height).toBeCloseTo(before.height, 0);
  await page.screenshot({
    path: testInfo.outputPath("sidebar-drag-tooltip.png"),
  });
  await testInfo.attach("非法拖放 tooltip", {
    path: testInfo.outputPath("sidebar-drag-tooltip.png"),
    contentType: "image/png",
  });
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  await page.mouse.up();
  expect(
    f.writes.filter(
      (entry) => entry.path === "/api/workspaces/test-space/directory/move",
    ),
  ).toHaveLength(0);
  await expect(
    page.getByRole("tab", { name: "画布一", exact: true }),
  ).toHaveAttribute("aria-selected", "true");

  await page.setViewportSize({ width: 390, height: 640 });
  await folderName(page, "资料").click();
  await expect(treeRow(page, "folder", "f2")).toBeVisible();
  const folder = (await treeRow(page, "folder", "f1").boundingBox())!;
  const child = (await treeRow(page, "folder", "f2").boundingBox())!;

  await page.mouse.move(
    folder.x + folder.width / 2,
    folder.y + folder.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(child.x + child.width / 2, child.y + child.height / 2, {
    steps: 6,
  });
  await expect(tip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  await page.mouse.up();
  expect(
    f.writes.filter(
      (entry) => entry.path === "/api/workspaces/test-space/directory/move",
    ),
  ).toHaveLength(0);
});

test.describe("手机抽屉", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("抽屉内正常滚动与轻触展开，长按拖动不与菜单冲突且不误打开", async ({
    page,
    workspace: _workspace,
  }) => {
    const f = await directoryFixture(page, { extra: 12 });
    const toggle = page.getByRole("button", {
      name: "切换工作空间侧边栏",
      exact: true,
    });

    if (
      await page
        .getByRole("list", { name: "我的文件", exact: true })
        .isVisible()
    )
      await page
        .getByRole("button", { name: "收起侧边栏", exact: true })
        .click();
    await expect(
      page.getByRole("list", { name: "我的文件", exact: true }),
    ).toBeHidden();
    await toggle.click();
    await expect(
      page.getByRole("list", { name: "我的文件", exact: true }),
    ).toBeVisible();
    const mobileSlot = treeRow(page, "folder", "f1").locator(
      "[data-node-icon]",
    );

    const mobileSymbol = mobileSlot.locator(".folder-symbol");
    const mobileChevron = mobileSlot.locator(".folder-chevron");
    const shown = (locator: typeof mobileSymbol) =>
      locator.evaluate((element) => {
        const style = getComputedStyle(element);

        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) > 0
        );
      });

    await expect.poll(() => shown(mobileSymbol)).toBe(true);
    await expect.poll(() => shown(mobileChevron)).toBe(false);
    await more(page, "文件夹 资料 的操作").click();
    const folderMenu = menu(page, "文件夹 资料 的操作");

    await expect(folderMenu).toBeVisible();
    await expect(
      folderMenu.getByRole("menuitem", { name: "移动到…", exact: true }),
    ).toBeVisible();
    await expect(
      folderMenu.getByRole("menuitem", { name: "新建文件夹", exact: true }),
    ).toBeVisible();
    const bounds = (await folderMenu.boundingBox())!;

    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    await page.keyboard.press("Escape");
    const scroll = page.locator(".sidebar-scroll");
    const beforeScroll = await scroll.evaluate((element) => element.scrollTop);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, x: number, y: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints:
          type === "touchEnd" ? [] : [{ x, y, radiusX: 2, radiusY: 2 }],
      });

    await touch("touchStart", 120, 700);
    for (const y of [660, 620, 580, 540, 500]) await touch("touchMove", 120, y);
    await touch("touchEnd", 0, 0);
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(beforeScroll);

    const source = treeRow(page, "canvas", "c2");
    const folder = treeRow(page, "folder", "f1");

    await source.scrollIntoViewIfNeeded();
    await folder.scrollIntoViewIfNeeded();
    const sourceBox = (await source.boundingBox())!;
    const folderBox = (await folder.boundingBox())!;

    await touch(
      "touchStart",
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2,
    );
    await page.waitForTimeout(600);
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    await touch(
      "touchMove",
      folderBox.x + folderBox.width / 2,
      folderBox.y + folderBox.height / 2,
    );
    await touch("touchEnd", 0, 0);
    await expect
      .poll(
        () =>
          f.writes.filter(
            (entry) =>
              entry.path === "/api/workspaces/test-space/directory/move",
          ).length,
      )
      .toBe(1);
    await expect(
      page.getByRole("tab", { name: "画布一", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[role="menu"]')).toHaveCount(0);

    await folderName(page, "资料").click();
    await expect(treeRow(page, "canvas", "c3")).toBeVisible();
    await expect.poll(() => shown(mobileSymbol)).toBe(true);
    await expect.poll(() => shown(mobileChevron)).toBe(false);
    await treeRow(page, "canvas", "c2")
      .getByRole("button", { name: "画布二", exact: true })
      .click();
    await expect(
      page.getByRole("list", { name: "我的文件", exact: true }),
    ).toBeHidden();
    await expect(
      page.getByRole("tab", { name: "画布二", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  });
});
