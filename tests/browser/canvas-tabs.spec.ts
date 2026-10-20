import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { CanvasDocument } from "../../shared/contracts";
import { test, expect, editorState } from "./fixtures";

async function tabsFixture(page: Page, longName = false) {
  const spaces = ["test-space", "second-space"].map((id, index) => ({
    id,
    name: index ? "第二空间" : "测试空间",
    catalogRevision: 0,
    createdAt: "2026-10-14",
    updatedAt: "2026-10-14",
  }));
  let canvases: CanvasDocument[] = ["a", "b", "c"].map((id, index) => ({
    id,
    name:
      longName && id === "b"
        ? "这是一张名称很长的画布，用来检查标签省略与横向滚动"
        : `画布 ${id.toUpperCase()}`,
    workspaceId: index === 2 ? "second-space" : "test-space",
    position: index,
    revision: 0,
    createdAt: "2026-10-14",
    updatedAt: "2026-10-14",
    scene: { elements: [], appState: {}, files: {} },
  }));
  let holdSave: Promise<void> | undefined;
  let releaseSave = () => {};
  let saveStarted = false;
  let failSave = false;
  const presence: { id: string; leave: boolean }[] = [];
  const writes: string[] = [];
  let userId = "test-user";

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/workspaces")
      return route.fulfill({ json: { workspaces: spaces } });
    if (path === "/api/logout") return route.fulfill({ json: { ok: true } });
    if (path === "/api/login") {
      userId = "second-user";

      return route.fulfill({
        json: {
          user: {
            id: userId,
            email: "second@example.test",
            name: "第二账号",
            role: "admin",
          },
        },
      });
    }

    if (path === "/api/session")
      return route.fulfill({
        json: {
          user: {
            id: userId,
            email: "browser@example.test",
            name: "测试用户",
            role: "admin",
          },
        },
      });
    if (path === "/api/navigation")
      return route.fulfill({
        json: {
          revision: 0,
          lastWorkspaceId: "test-space",
          lastCanvasId:
            method === "PUT" ? request.postDataJSON().canvasId : "a",
          workspaces: [],
        },
      });
    const directory = path.match(/^\/api\/workspaces\/([^/]+)\/canvases$/);

    if (directory) {
      if (method === "POST") {
        const created = {
          ...canvases[0]!,
          id: `new-${canvases.length}`,
          workspaceId: directory[1]!,
          name: request.postDataJSON().name,
          scene: { elements: [], appState: {}, files: {} },
        };

        canvases.push(created);

        return route.fulfill({ json: { canvas: created } });
      }

      return route.fulfill({
        json: {
          canvases: canvases.filter(
            (canvas) => canvas.workspaceId === directory[1],
          ),
          catalogRevision: 0,
        },
      });
    }

    const presencePath = path.match(/^\/api\/canvases\/([^/]+)\/presence$/);

    if (presencePath) {
      presence.push({
        id: presencePath[1]!,
        leave: !!request.postDataJSON().leave,
      });

      return route.fulfill({ json: { syncMode: "legacy" } });
    }

    const canvas = canvases.find(
      (canvas) => path === `/api/canvases/${canvas.id}`,
    );

    if (!canvas) return route.fallback();
    if (method === "PATCH") canvas.name = request.postDataJSON().name;
    if (method === "DELETE") {
      canvases = canvases.filter((item) => item.id !== canvas.id);

      return route.fulfill({ json: { ok: true } });
    }

    if (method === "PUT") {
      writes.push(canvas.id);
      saveStarted = true;
      await holdSave;
      if (failSave)
        return route.fulfill({
          status: 503,
          json: { error: { code: "OFFLINE", message: "后台保存失败" } },
        });
      canvas.scene = request.postDataJSON().scene;
      canvas.revision++;

      return route.fulfill({
        json: { revision: canvas.revision, updatedAt: canvas.updatedAt },
      });
    }

    return route.fulfill({ json: { canvas } });
  });
  await page.reload();
  await expect(
    page.getByRole("tab", { name: "画布 A", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() => editorState(page).then((state) => state.viewModeEnabled))
    .toBe(false);

  return {
    presence,
    writes,
    canvas: (id: string) => canvases.find((canvas) => canvas.id === id)!,
    holdSave() {
      holdSave = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
    },
    releaseSave: () => releaseSave(),
    saveStarted: () => saveStarted,
    failSave: (value: boolean) => {
      failSave = value;
    },
  };
}

async function openCanvas(page: Page, id: string) {
  const sidebar = page.locator(".workspace-sidebar");

  if (!(await sidebar.isVisible()))
    await page
      .getByRole("button", { name: "切换工作空间侧边栏", exact: true })
      .click();
  await page.locator(`[data-canvas-id="${id}"] .canvas-name`).click();
  await expect(page.locator(".excalidraw")).toHaveCount(1);
  await expect
    .poll(() => editorState(page).then((state) => state.viewModeEnabled))
    .toBe(false);
}

async function drawRectangle(page: Page) {
  await page.getByRole("button", { name: "矩形", exact: true }).click();
  const bounds = await page.locator(".excalidraw").boundingBox();
  const x = bounds!.x + 250,
    y = bounds!.y + 250;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y + 80);
  await page.mouse.up();
  await expect
    .poll(() =>
      editorState(page).then(
        (state) =>
          state.elements.filter((element: any) => !element.isDeleted).length,
      ),
    )
    .toBe(1);
}

async function editorAPI(page: Page, operation: "image" | "delete" | "remove") {
  await page.locator(".excalidraw").evaluate((element, operation) => {
    const node = element as any;
    let fiber =
      node[Object.keys(node).find((key) => key.startsWith("__reactFiber$"))!];

    while (fiber && !fiber.stateNode?.state?.activeTool) fiber = fiber.return;
    const api = fiber.stateNode.api;

    if (operation === "image") {
      const canvas = document.createElement("canvas");

      canvas.width = 32;
      canvas.height = 32;
      canvas.getContext("2d")!.fillRect(0, 0, 32, 32);
      api.addFiles([
        {
          id: "history-image",
          dataURL: canvas.toDataURL(),
          mimeType: "image/png",
          created: 1,
          lastRetrieved: 1,
        },
      ]);
      api.updateScene({
        elements: [
          {
            id: "history-image-element",
            type: "image",
            x: 150,
            y: 150,
            width: 64,
            height: 64,
            angle: 0,
            strokeColor: "transparent",
            backgroundColor: "transparent",
            fillStyle: "solid",
            strokeWidth: 1,
            strokeStyle: "solid",
            roughness: 0,
            opacity: 100,
            groupIds: [],
            frameId: null,
            roundness: null,
            seed: 1,
            version: 1,
            versionNonce: 1,
            isDeleted: false,
            boundElements: null,
            updated: 1,
            link: null,
            locked: false,
            fileId: "history-image",
            scale: [1, 1],
            status: "saved",
            crop: null,
          },
        ],
        captureUpdate: "IMMEDIATELY",
      });
    } else
      api.updateScene({
        elements:
          operation === "remove"
            ? []
            : api.getSceneElementsIncludingDeleted().map((element: any) => ({
                ...element,
                isDeleted: true,
                version: element.version + 1,
                versionNonce: 2,
              })),
        captureUpdate: "IMMEDIATELY",
      });
  }, operation);
}

test("undo and redo histories remain separate across tabs and restore toolbar enabled state", async ({
  page,
  workspace: _workspace,
}) => {
  await tabsFixture(page);
  await drawRectangle(page);
  const selection = (await editorState(page)).selectedElementIds;

  expect(Object.keys(selection)).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "撤销", exact: true }),
  ).toBeEnabled();
  await openCanvas(page, "b");
  await expect(
    page.getByRole("button", { name: "撤销", exact: true }),
  ).toBeDisabled();
  await page.getByRole("tab", { name: "画布 A", exact: true }).click();
  await expect
    .poll(() => editorState(page).then((state) => state.selectedElementIds))
    .toEqual(selection);
  await expect(
    page.getByRole("button", { name: "撤销", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(() =>
      editorState(page).then(
        (state) =>
          state.elements.filter((element: any) => !element.isDeleted).length,
      ),
    )
    .toBe(0);
  await page.getByRole("tab", { name: "画布 B", exact: true }).click();
  await page.getByRole("tab", { name: "画布 A", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重做", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect
    .poll(() =>
      editorState(page).then(
        (state) =>
          state.elements.filter((element: any) => !element.isDeleted).length,
      ),
    )
    .toBe(1);
  await page.getByRole("tab", { name: "画布 A", exact: true }).focus();
  await page.keyboard.press("Delete");
  await expect(
    page.getByRole("tab", { name: "画布 A", exact: true }),
  ).toHaveCount(0);
  await openCanvas(page, "a");
  await expect
    .poll(() =>
      editorState(page).then(
        (state) =>
          state.elements.filter((element: any) => !element.isDeleted).length,
      ),
    )
    .toBe(1);
  await page
    .getByRole("button", { name: "关闭画布标签 画布 A", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("tab", { name: "画布 A", exact: true }),
  ).toHaveCount(0);
  await openCanvas(page, "a");
  await expect(
    page.getByRole("button", { name: "撤销", exact: true }),
  ).toBeDisabled();
});

test("deleted-image undo retains its file, and force-removed elements use saved fallback data", async ({
  page,
  workspace: _workspace,
}) => {
  const mock = await tabsFixture(page);

  await editorAPI(page, "image");
  await expect
    .poll(() => editorState(page).then((state) => state.elements.length))
    .toBe(1);
  await editorAPI(page, "delete");
  await openCanvas(page, "b");
  await expect
    .poll(() => Object.keys(mock.canvas("a").scene.files).length)
    .toBe(0);
  await page.getByRole("tab", { name: "画布 A", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "撤销", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(() =>
      editorState(page).then(
        (state) =>
          state.elements.filter((element: any) => !element.isDeleted).length,
      ),
    )
    .toBe(1);
  await page.getByRole("button", { name: "保存 Ctrl S", exact: true }).click();
  await expect
    .poll(() => Object.keys(mock.canvas("a").scene.files))
    .toEqual(["history-image"]);
  await editorAPI(page, "remove");
  await expect
    .poll(() => editorState(page).then((state) => state.elements.length))
    .toBe(0);
  await openCanvas(page, "b");
  await page.getByRole("tab", { name: "画布 A", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "撤销", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(() =>
      editorState(page).then(
        (state) =>
          state.elements.filter((element: any) => !element.isDeleted).length,
      ),
    )
    .toBe(1);
});

test("remote content changes and epoch changes discard obsolete tab history", async ({
  page,
  workspace: _workspace,
}) => {
  const mock = await tabsFixture(page);

  await drawRectangle(page);
  await openCanvas(page, "b");
  await expect.poll(() => mock.canvas("a").revision).toBe(1);
  const element = mock.canvas("a").scene.elements[0] as any;

  element.x = 900;
  element.version++;
  element.versionNonce++;
  mock.canvas("a").revision++;
  await page.getByRole("tab", { name: "画布 A", exact: true }).click();
  await expect
    .poll(() => editorState(page).then((state) => state.elements[0]?.x))
    .toBe(900);
  await expect(
    page.getByRole("button", { name: "撤销", exact: true }),
  ).toBeDisabled();
  await editorAPI(page, "delete");
  await openCanvas(page, "b");
  await expect
    .poll(() => mock.canvas("a").scene.elements[0])
    .toHaveProperty("isDeleted", true);
  mock.canvas("a").migrationEpoch = "new-epoch";
  await page.getByRole("tab", { name: "画布 A", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "撤销", exact: true }),
  ).toBeDisabled();
});

test("two tabs preserve each canvas's view, tool and local edits, with one mounted editor", async ({
  page,
  workspace: _workspace,
}) => {
  const mock = await tabsFixture(page);

  mock.holdSave();
  try {
    await drawRectangle(page);
    await page
      .getByRole("button", { name: "抓手（平移工具）", exact: true })
      .click();
    const bounds = await page.locator(".excalidraw").boundingBox();
    const x = bounds!.x + 450,
      y = bounds!.y + 350;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 150, y + 100);
    await page.mouse.up();
    await page.getByRole("button", { name: "椭圆", exact: true }).click();
    await expect
      .poll(() => editorState(page).then((state) => state.activeTool.type))
      .toBe("ellipse");
    const original = await editorState(page);

    expect(original.scrollX).not.toBe(0);

    await openCanvas(page, "b");
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect.poll(mock.saveStarted).toBe(true);
    await expect
      .poll(() => editorState(page).then((state) => state.elements.length))
      .toBe(0);
    mock.releaseSave();
    await expect.poll(() => mock.canvas("a").revision).toBe(1);
    await page.getByRole("tab", { name: "画布 A", exact: true }).click();
    await expect
      .poll(() => editorState(page).then((state) => state.activeTool.type))
      .toBe("ellipse");
    const restored = await editorState(page);

    expect(restored.scrollX).toBeCloseTo(original.scrollX);
    expect(restored.scrollY).toBeCloseTo(original.scrollY);
    expect(restored.zoom).toEqual(original.zoom);
    expect(
      restored.elements.filter((element: any) => !element.isDeleted),
    ).toHaveLength(1);
    await expect(page.locator(".excalidraw")).toHaveCount(1);
    await openCanvas(page, "a");
    await expect(page.getByRole("tab")).toHaveCount(2);
  } finally {
    mock.releaseSave();
  }
});

test("closing pending background and last tabs retains saves, unload protection and files", async ({
  page,
  workspace: _workspace,
}) => {
  const mock = await tabsFixture(page);

  mock.holdSave();
  try {
    await drawRectangle(page);
    await openCanvas(page, "b");
    await expect.poll(mock.saveStarted).toBe(true);
    await page
      .getByRole("button", { name: "关闭画布标签 画布 A", exact: true })
      .click();
    await page
      .getByRole("button", { name: "关闭画布标签 画布 B", exact: true })
      .click();
    await expect(page.locator(".excalidraw")).toHaveCount(0);
    await expect(
      page.getByText("从侧边栏打开画布，或新建一张画布。", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".canvas-name")).toHaveCount(2);
    expect(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });

        window.dispatchEvent(event);

        return event.defaultPrevented;
      }),
    ).toBe(true);
    mock.releaseSave();
    await expect.poll(() => mock.canvas("a").revision).toBe(1);
    await openCanvas(page, "a");
    await expect
      .poll(() =>
        editorState(page).then(
          (state) =>
            state.elements.filter((element: any) => !element.isDeleted).length,
        ),
      )
      .toBe(1);
    expect(
      mock.presence.filter((entry) => entry.id === "a" && !entry.leave),
    ).toHaveLength(2);
    expect(mock.presence.some((entry) => entry.id === "b" && entry.leave)).toBe(
      true,
    );
  } finally {
    mock.releaseSave();
  }
});

test("tabs support keyboard navigation, adjacent close focus, rename, delete and new file", async ({
  page,
  workspace: _workspace,
}) => {
  await tabsFixture(page);
  await openCanvas(page, "b");
  await page.getByRole("tab", { name: "画布 B", exact: true }).focus();
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("tab", { name: "画布 A", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tab", { name: "画布 A", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "画布 B", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.locator('[data-canvas-id="b"] .canvas-name').dblclick();
  const rename = page.getByRole("dialog", { name: "重命名画布", exact: true });

  await rename.getByRole("textbox").fill("新的标签名称");
  await rename.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "新的标签名称", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "新的标签名称", exact: true }).focus();
  await page.keyboard.press("Delete");
  await expect(
    page.getByRole("tab", { name: "画布 A", exact: true }),
  ).toBeFocused();
  await openCanvas(page, "b");
  await page
    .locator('[data-canvas-id="b"] .canvas-name')
    .click({ button: "right" });
  await page
    .getByRole("menu", { name: "画布 新的标签名称 的操作", exact: true })
    .getByRole("menuitem", { name: "删除画布", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "移入回收站", exact: true })
    .getByRole("button", { name: "移入回收站", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "新的标签名称", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "画布 A", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建画布", exact: true });

  await create.getByRole("textbox").fill("新标签");
  await create.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "新标签", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("workspace tabs restore their active file and clear when changing account", async ({
  page,
  workspace: _workspace,
}) => {
  await tabsFixture(page);
  await openCanvas(page, "b");
  await page.locator("#workspace-select").click();
  await page.getByRole("option", { name: "第二空间", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "画布 C", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.locator("#workspace-select").click();
  await page.getByRole("option", { name: "测试空间", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(
    page.getByRole("tab", { name: "画布 B", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.getByLabel("邮箱", { exact: true }).fill("second@example.test");
  await page.getByLabel("密码", { exact: true }).fill("Password-2026!");
  await page.getByRole("button", { name: "进入我的空间", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(
    page.getByRole("tab", { name: "画布 A", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("a background draft's error opens its own workspace and canvas tab", async ({
  page,
  workspace: _workspace,
}) => {
  const mock = await tabsFixture(page);

  mock.failSave(true);
  await drawRectangle(page);
  await page.locator("#workspace-select").click();
  await page.getByRole("option", { name: "第二空间", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "画布 C", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const error = page
    .getByRole("alert")
    .filter({ hasText: /画布 A：.*后台保存失败/ });

  await expect(error).toBeVisible();
  mock.failSave(false);
  await error.getByRole("button", { name: "查看画布", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "画布 A", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#workspace-current-name")).toHaveText("测试空间");
  await expect
    .poll(() =>
      editorState(page).then(
        (state) =>
          state.elements.filter((element: any) => !element.isDeleted).length,
      ),
    )
    .toBe(1);
});

test("tab strip fits a narrow viewport and follows theme tokens", async ({
  page,
  workspace,
}) => {
  await tabsFixture(page, true);
  await openCanvas(page, "b");
  await page.screenshot({ path: "/tmp/canvas-tabs-light.png" });
  await workspace.open();
  await page.getByRole("tab", { name: "通用", exact: true }).click();
  await page.getByRole("button", { name: /外观主题：/ }).click();
  await page.getByRole("option", { name: "深色", exact: true }).click();
  await workspace.close();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "/tmp/canvas-tabs-dark.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();
  await page.getByRole("tab", { name: "画布 A", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "画布 A", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/canvas-tabs-mobile.png" });
});

test("rich text survives tab changes, reload and an actual .excalidraw file round trip", async ({
  page,
  workspace,
}) => {
  await page.addInitScript(() => {
    // Exercise the standard browser download path instead of an OS file picker.
    Reflect.deleteProperty(window, "showOpenFilePicker");
    Reflect.deleteProperty(window, "showSaveFilePicker");
  });
  const fixture = await tabsFixture(page);

  await page.getByTestId("toolbar-text").first().click();
  await page.mouse.click(700, 350);
  const input = page.locator(".excalidraw-wysiwyg");

  await input.pressSequentially("**Persistent** plain *italic* `code`", {
    delay: 10,
  });
  await input.press("Enter");
  await input.press("Enter");
  await input.pressSequentially("中文 👩‍💻");
  await input.press("Escape");
  const expected = (await editorState(page)).elements[0] as any;

  await page.getByRole("button", { name: "保存 Ctrl S", exact: true }).click();
  await expect
    .poll(() => (fixture.canvas("a").scene.elements[0] as any)?.richText)
    .toEqual(expected.richText);
  await openCanvas(page, "b");
  expect((await editorState(page)).elements).toHaveLength(0);
  await page.locator("#canvas-tab-a").click();
  await expect
    .poll(() =>
      editorState(page).then((state) => (state.elements[0] as any)?.richText),
    )
    .toEqual(expected.richText);
  await page.reload();
  await expect
    .poll(() =>
      editorState(page).then((state) => (state.elements[0] as any)?.richText),
    )
    .toEqual(expected.richText);
  await page.mouse.dblclick(705, 355);
  await expect(input.locator("strong")).toHaveText("Persistent");
  await expect(input.locator("em")).toHaveText("italic");
  await expect(input.locator("code")).toHaveText("code");
  await input.press("Escape");
  const downloaded = page.waitForEvent("download");

  await page.locator(".excalidraw").evaluate(async (node) => {
    const host = node as any;
    let fiber =
      host[Object.keys(host).find((key) => key.startsWith("__reactFiber$"))!];

    while (fiber && !fiber.stateNode?.api?.getSceneElements)
      fiber = fiber.return;
    const app = fiber.stateNode;

    await app.actionManager.actions.saveFileToDisk.perform(
      app.api.getSceneElements(),
      app.state,
      null,
      app,
    );
  });
  const download = await downloaded;
  const file = await readFile((await download.path())!, "utf8");

  expect(download.suggestedFilename()).toMatch(/\.excalidraw$/);
  expect(JSON.parse(file).elements[0].richText).toEqual(expected.richText);
  await openCanvas(page, "b");
  await page.locator(".excalidraw").evaluate((node, contents) => {
    const transfer = new DataTransfer();

    transfer.items.add(
      new File([contents], "rich-text.excalidraw", {
        type: "application/vnd.excalidraw+json",
      }),
    );
    node.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: 700,
        clientY: 350,
      }),
    );
  }, file);
  await expect
    .poll(() =>
      editorState(page).then((state) => (state.elements[0] as any)?.richText),
    )
    .toEqual(expected.richText);
  expect((await editorState(page)).elements[0]?.originalText).toBe(
    expected.originalText,
  );
});
