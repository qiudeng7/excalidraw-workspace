import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import {
  createDefaultUserSettings,
  type CanvasDocument,
} from "../../shared/contracts";
import { editorState } from "./fixtures";
import { currentRelease } from "../../src/data/releases";
import { announcementKey } from "../../src/lib/releaseProgress";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function rectangle(id: string, x = 100) {
  return {
    type: "rectangle",
    id,
    x,
    y: 100,
    width: 100,
    height: 80,
    angle: 0,
    strokeColor: "#1e1e1e",
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
  };
}

async function fixture(
  page: Page,
  enabled = false,
  options: { deletedElements?: boolean } = {},
) {
  const settings = createDefaultUserSettings();

  settings.features.disableDefaultSidebar = !enabled;
  const user = {
    id: "cache-user",
    email: "cache@example.test",
    name: "缓存测试",
    role: "admin",
  };

  await page.addInitScript(({ key, id }) => localStorage.setItem(key, id), {
    key: announcementKey(user.id, currentRelease.sequence),
    id: currentRelease.id,
  });
  const workspace = {
    id: "cache-space",
    name: "缓存空间",
    catalogRevision: 0,
    createdAt: "2026-10-12",
    updatedAt: "2026-10-12",
  };
  const canvases: Record<string, CanvasDocument> = Object.fromEntries(
    ["a", "b", "c"].map((id, position) => [
      id,
      {
        id,
        name: `画布 ${id.toUpperCase()}`,
        workspaceId: workspace.id,
        position,
        revision: 0,
        createdAt: "2026-10-12",
        updatedAt: "2026-10-12",
        scene: {
          elements: [
            rectangle(id),
            ...(options.deletedElements
              ? [{ ...rectangle(`${id}-deleted`), isDeleted: true }]
              : []),
          ],
          appState: {},
          files: {},
        },
      },
    ]),
  );
  const counts = new Map<string, number>();
  const readGates = new Map<string, ReturnType<typeof deferred>>();
  const putGates = new Map<string, ReturnType<typeof deferred>>();
  const errors: string[] = [];
  let navigationRevision = 0;
  let settingsRevision = 0;
  let failRead = "";
  let libraryFailure = 0;
  let libraryData = { items: [] as unknown[], revision: 0 };

  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.text().includes("[NUXT_E1005]")) errors.push(message.text());
  });
  page.on("response", (response) => {
    if (
      response.request().resourceType() === "script" &&
      response.status() >= 400
    )
      errors.push(`Script HTTP ${response.status()}: ${response.url()}`);
  });
  const noRuntimeOverlay = async () => {
    await expect(
      page.locator(
        "[data-nuxt-dev-error], nuxt-error-overlay, vite-error-overlay",
      ),
    ).toHaveCount(0);
  };

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const key = `${req.method()} ${path}`;

    counts.set(key, (counts.get(key) ?? 0) + 1);
    let body: unknown;

    switch (key) {
      case "GET /api/bootstrap":
        body = {
          needsSetup: false,
          registrationEnabled: true,
          emailVerification: false,
        };
        break;
      case "GET /api/session":
        body = { user };
        break;
      case "GET /api/user-settings":
        body = { settings, configured: true, revision: settingsRevision };
        break;
      case "PUT /api/user-settings":
        Object.assign(settings, req.postDataJSON().settings);
        body = { settings, configured: true, revision: ++settingsRevision };
        break;
      case "GET /api/workspaces":
        body = { workspaces: [workspace] };
        break;
      case "GET /api/shared-canvases":
        body = { canvases: [] };
        break;
      case "POST /api/canvases/a/presence":
      case "POST /api/canvases/b/presence":
      case "POST /api/canvases/c/presence":
        body = { syncMode: "legacy" };
        break;
      case "GET /api/workspaces/cache-space/canvases":
        body = { canvases: Object.values(canvases), catalogRevision: 0 };
        break;
      case "GET /api/navigation":
        body = {
          revision: navigationRevision,
          lastWorkspaceId: workspace.id,
          lastCanvasId: "a",
          workspaces: [],
        };
        break;
      case "PUT /api/navigation":
        body = {
          revision: ++navigationRevision,
          lastWorkspaceId: workspace.id,
          lastCanvasId: req.postDataJSON().canvasId,
          workspaces: [],
        };
        break;
      case "GET /api/library":
        await readGates.get("library")?.promise;
        body = libraryData;
        break;
      case "PUT /api/library":
        if (libraryFailure) {
          await route.fulfill({
            status: libraryFailure,
            json: {
              error: {
                code: libraryFailure === 409 ? "REVISION_CONFLICT" : "OFFLINE",
                message: "素材库模拟保存失败",
              },
            },
          });

          return;
        }

        libraryData = {
          items: req.postDataJSON().items,
          revision: libraryData.revision + 1,
        };
        body = { revision: libraryData.revision, updatedAt: "library-updated" };
        break;
      default: {
        const match = path.match(/^\/api\/canvases\/([abc])$/);

        if (!match) {
          errors.push(`Unexpected API ${key}`);
          await route.abort();

          return;
        }

        const id = match[1]!;

        if (req.method() === "GET") {
          await readGates.get(id)?.promise;
          if (failRead === id) {
            await route.fulfill({
              status: 503,
              json: { error: { code: "OFFLINE", message: "模拟离线" } },
            });

            return;
          }

          if (
            req
              .headers()
              ["if-none-match"]?.includes(`%3A${canvases[id]!.revision}%3A`)
          ) {
            await route.fulfill({ status: 304, body: "" });

            return;
          }

          body = { canvas: canvases[id] };
        } else if (req.method() === "PUT") {
          await putGates.get(id)?.promise;
          const data = req.postDataJSON();

          if (data.revision !== canvases[id]!.revision) {
            await route.fulfill({
              status: 409,
              json: {
                error: { code: "REVISION_CONFLICT", message: "模拟版本冲突" },
              },
            });

            return;
          }

          canvases[id] = {
            ...canvases[id]!,
            scene: data.scene,
            revision: data.revision + 1,
            updatedAt: `updated-${data.revision + 1}`,
          };
          body = {
            revision: canvases[id]!.revision,
            updatedAt: canvases[id]!.updatedAt,
          };
        } else {
          errors.push(`Unexpected API ${key}`);
          await route.abort();

          return;
        }
      }
    }

    await route.fulfill({ json: body });
  });
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible();
  await noRuntimeOverlay();
  await expect
    .poll(() => editorState(page).then((value) => value.elements[0]?.id))
    .toBe("a");
  const select = async (id: string) => {
    await page
      .getByRole("button", { name: `画布 ${id.toUpperCase()}`, exact: true })
      .click();
  };
  const ready = async (id: string) => {
    await expect
      .poll(() => editorState(page).then((value) => value.elements[0]?.id))
      .toBe(id);
    await expect(page.locator(".save-state")).not.toHaveText("正在校验版本…");
    await expect(page.getByTestId("canvas-sync-lock")).toHaveCount(0);
    await noRuntimeOverlay();
  };

  return {
    counts,
    readGates,
    putGates,
    canvases,
    errors,
    select,
    ready,
    failLibrary: (status: number) => {
      libraryFailure = status;
    },
    fail: (id: string) => {
      failRead = id;
    },
  };
}

test("arrow selection preference follows cached canvas switches without changing scene revisions", async ({
  page,
}) => {
  const mock = await fixture(page);
  const revisions = Object.values(mock.canvases).map(
    (canvas) => canvas.revision,
  );

  await expect
    .poll(() => editorState(page).then((s) => s.arrowSelectionHighlight))
    .toBe(true);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });

  await dialog.getByRole("tab", { name: "编辑器", exact: true }).click();
  await dialog
    .getByRole("checkbox", { name: "箭头沿线选中高亮", exact: true })
    .locator("..")
    .click();
  await expect
    .poll(() => editorState(page).then((s) => s.arrowSelectionHighlight))
    .toBe(false);
  await expect
    .poll(() => mock.counts.get("PUT /api/user-settings") ?? 0)
    .toBe(1);
  await dialog.getByRole("button", { name: "关闭设置" }).click();
  for (const id of ["b", "a", "c"]) {
    await mock.select(id);
    await mock.ready(id);
    expect((await editorState(page)).arrowSelectionHighlight).toBe(false);
  }

  await page.reload();
  await mock.ready("a");
  expect((await editorState(page)).arrowSelectionHighlight).toBe(false);
  expect(Object.values(mock.canvases).map((canvas) => canvas.revision)).toEqual(
    revisions,
  );
  expect(mock.errors).toEqual([]);
});

for (const enabled of [false, true])
  test(`library is lazy when default sidebar ${enabled ? "enabled" : "disabled"}`, async ({
    page,
  }) => {
    const mock = await fixture(page, enabled);

    await mock.select("b");
    await mock.ready("b");
    await mock.select("a");
    await mock.ready("a");
    expect(mock.counts.get("GET /api/library") ?? 0).toBe(0);
    expect(mock.counts.get("PUT /api/library") ?? 0).toBe(0);
    if (enabled) {
      const gate = deferred();

      mock.readGates.set("library", gate);
      await page.locator(".default-sidebar-trigger").click();
      await expect.poll(() => mock.counts.get("GET /api/library") ?? 0).toBe(1);
      await expect(
        page.getByText("正在加载素材库…", { exact: true }),
      ).toBeVisible();
      gate.resolve();
      await expect(
        page.getByText("正在加载素材库…", { exact: true }),
      ).toHaveCount(0);
      await mock.select("b");
      await mock.ready("b");
      expect(mock.counts.get("GET /api/library")).toBe(1);
      expect(mock.counts.get("PUT /api/library") ?? 0).toBe(0);
    }

    expect(mock.errors).toEqual([]);
  });

test("cached preview stays read-only across keyboard, paste, drop and action paths while navigation works", async ({
  page,
}) => {
  const mock = await fixture(page);

  await mock.select("b");
  await mock.ready("b");
  const gate = deferred();

  mock.readGates.set("a", gate);
  await mock.select("a");
  await expect(page.locator(".save-state")).toHaveText("正在校验版本…");
  await expect(page.locator(".save-state")).toHaveAttribute(
    "title",
    "正在确认最新版本，暂时只读，可平移和缩放。",
  );
  await expect(page.getByTestId("canvas-sync-lock")).toHaveCount(0);
  await expect(page.locator(".canvas-editor-shell > .save-notice")).toHaveCount(
    0,
  );
  await expect
    .poll(() => editorState(page).then((value) => value.viewModeEnabled))
    .toBe(true);
  const before = await editorState(page);
  const host = page.locator(".excalidraw");

  await host.focus();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+Shift+z");
  await page.evaluate(() => navigator.clipboard.writeText("只读不能新增文字"));
  await page.keyboard.press("Control+v");
  await host.evaluate((element) => {
    let fiber = (element as any)[
      Object.keys(element).find((key) => key.startsWith("__reactFiber$"))!
    ];

    while (fiber && !fiber.stateNode?.actionManager) fiber = fiber.return;
    const app = fiber.stateNode;

    for (const name of ["clearCanvas", "undo", "redo", "loadScene"])
      if (app.actionManager.actions[name])
        app.actionManager.executeAction(app.actionManager.actions[name], "ui");
    app.addElementsFromPasteOrLibrary({
      elements: [app.api.getSceneElements()[0]],
      files: {},
      position: "center",
    });
    const data = new DataTransfer();

    data.items.add(
      new File(
        [JSON.stringify({ type: "excalidraw", version: 2, elements: [] })],
        "empty.excalidraw",
        { type: "application/json" },
      ),
    );
    element.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const box = await host.boundingBox();

  await page.mouse.move(box!.x + 500, box!.y + 350);
  await page.mouse.wheel(0, 120);
  await expect
    .poll(() => editorState(page).then((value) => value.scrollY))
    .not.toBe(before.scrollY);
  expect((await editorState(page)).elements).toEqual(before.elements);
  expect(mock.counts.get("PUT /api/canvases/a") ?? 0).toBe(0);
  gate.resolve();
  await mock.ready("a");
  await expect
    .poll(() => editorState(page).then((value) => value.viewModeEnabled))
    .toBe(false);
  expect(mock.errors).toEqual([]);
});

test("unchanged canvases with deleted elements do not save on initialization, viewing or switching", async ({
  page,
}) => {
  const mock = await fixture(page, false, { deletedElements: true });

  await mock.ready("a");
  await page.getByTestId("toolbar-rectangle").first().click();
  const box = (await page.locator(".excalidraw").boundingBox())!;

  await page.mouse.move(box.x + 500, box.y + 350);
  await page.mouse.wheel(0, 120);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  for (const id of ["b", "a", "c", "a"]) {
    await mock.select(id);
    await mock.ready(id);
    await expect(page.locator(".save-state")).toHaveText("已保存");
  }

  for (const id of ["a", "b", "c"]) {
    expect(mock.counts.get(`PUT /api/canvases/${id}`) ?? 0).toBe(0);
    expect(mock.canvases[id]!.revision).toBe(0);
  }

  expect(mock.errors).toEqual([]);
});

test("pending A network save does not delay B; fast return to A waits for its own save", async ({
  page,
}) => {
  const mock = await fixture(page, false, { deletedElements: true });
  const gate = deferred();

  mock.putGates.set("a", gate);
  await page.locator(".excalidraw").evaluate((element) => {
    let fiber = (element as any)[
      Object.keys(element).find((key) => key.startsWith("__reactFiber$"))!
    ];

    while (fiber && !fiber.stateNode?.api) fiber = fiber.return;
    const app = fiber.stateNode;
    const elements = app.api.getSceneElementsIncludingDeleted();

    app.api.updateScene({
      elements: elements.map((element: any, index: number) =>
        index === 0 ? { ...element, width: 160, version: 2 } : element,
      ),
    });
  });
  await expect.poll(() => mock.counts.get("PUT /api/canvases/a") ?? 0).toBe(1);
  await mock.select("b");
  await mock.ready("b");
  expect(mock.canvases.a!.revision).toBe(0);
  await mock.select("a");
  await expect(page.locator(".save-state")).toHaveText("正在校验版本…");
  gate.resolve();
  await mock.ready("a");
  expect((await editorState(page)).elements[0]!.width).toBe(160);
  expect(mock.canvases.a!.revision).toBe(1);
  expect(mock.counts.get("PUT /api/canvases/a")).toBe(1);
  expect(
    mock.canvases.a!.scene.elements.find(
      (element) => element.id === "a-deleted",
    )?.isDeleted,
  ).toBe(true);
  expect(mock.errors).toEqual([]);
});

test("network failure leaves cached preview locked and retry restores editing", async ({
  page,
}) => {
  const mock = await fixture(page);

  await mock.select("b");
  await mock.ready("b");
  mock.fail("a");
  await mock.select("a");
  await expect(
    page.getByText("版本校验失败，当前内容只读。", { exact: true }),
  ).toBeVisible();
  expect((await editorState(page)).elements[0]!.id).toBe("a");
  mock.fail("");
  await page.getByRole("button", { name: "重新校验", exact: true }).click();
  await mock.ready("a");
  expect(mock.errors).toEqual([]);
});

test("cache preview timing can be measured independently of a deliberately delayed validation", async ({
  page,
}) => {
  const mock = await fixture(page);

  await mock.select("b");
  await mock.ready("b");
  const gate = deferred();

  mock.readGates.set("a", gate);
  const start = await page.evaluate(() => performance.now());

  await mock.select("a");
  await expect(page.locator(".save-state")).toHaveText("正在校验版本…");
  await expect
    .poll(() => editorState(page).then((value) => value.elements[0]?.id))
    .toBe("a");
  const preview = await page.evaluate(() => performance.now());

  expect((await editorState(page)).viewModeEnabled).toBe(true);
  gate.resolve();
  await mock.ready("a");
  const editable = await page.evaluate(() => performance.now());

  console.log(
    JSON.stringify({
      scenario: "warm-memory-small-scene-controlled-validation",
      clickToPreviewMs: Math.round(preview - start),
      clickToEditableMs: Math.round(editable - start),
    }),
  );
  expect(mock.errors).toEqual([]);
});

test("disk cache remains visible and readonly during startup validation after reload", async ({
  page,
}) => {
  const mock = await fixture(page);
  const gate = deferred();

  mock.readGates.set("a", gate);
  await page.reload();
  await expect(page.locator(".save-state")).toHaveText("正在校验版本…");
  await expect
    .poll(() => editorState(page).then((value) => value.elements[0]?.id))
    .toBe("a");
  expect((await editorState(page)).viewModeEnabled).toBe(true);
  gate.resolve();
  await mock.ready("a");
  expect(mock.errors).toEqual([]);
});

test("latest canvas selection wins when B response arrives after C", async ({
  page,
}) => {
  const mock = await fixture(page);
  const gate = deferred();

  mock.readGates.set("b", gate);
  await mock.select("b");
  await expect.poll(() => mock.counts.get("GET /api/canvases/b") ?? 0).toBe(1);
  await mock.select("c");
  await mock.ready("c");
  const late = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/canvases/b",
  );

  gate.resolve();
  await late;
  await expect
    .poll(() => editorState(page).then((value) => value.elements[0]?.id))
    .toBe("c");
  expect(mock.errors).toEqual([]);
});

test("new remote content replaces a clean cached preview before editing unlocks", async ({
  page,
}) => {
  const mock = await fixture(page);

  await mock.select("b");
  await mock.ready("b");
  mock.canvases.a = {
    ...mock.canvases.a!,
    revision: 1,
    scene: { elements: [rectangle("remote-new")], appState: {}, files: {} },
  };
  const gate = deferred();

  mock.readGates.set("a", gate);
  await mock.select("a");
  await expect(page.locator(".save-state")).toHaveText("正在校验版本…");
  expect((await editorState(page)).elements[0]?.id).toBe("a");
  gate.resolve();
  await expect
    .poll(() => editorState(page).then((value) => value.elements[0]?.id))
    .toBe("remote-new");
  await expect(page.locator(".save-state")).toHaveText("已保存");
  await expect(page.getByTestId("canvas-sync-lock")).toHaveCount(0);
  expect(mock.counts.get("PUT /api/canvases/a") ?? 0).toBe(0);
  expect(mock.errors).toEqual([]);
});

test("background save conflict retains a downloadable local scene backup", async ({
  page,
}) => {
  const mock = await fixture(page);
  const gate = deferred();

  mock.putGates.set("a", gate);
  await page.locator(".excalidraw").evaluate((element) => {
    let fiber = (element as any)[
      Object.keys(element).find((key) => key.startsWith("__reactFiber$"))!
    ];

    while (fiber && !fiber.stateNode?.api) fiber = fiber.return;
    const app = fiber.stateNode;
    const elements = app.api.getSceneElements();

    app.api.updateScene({
      elements: [{ ...elements[0], width: 180, version: 2 }],
    });
  });
  await expect.poll(() => mock.counts.get("PUT /api/canvases/a") ?? 0).toBe(1);
  await mock.select("b");
  await mock.ready("b");
  mock.canvases.a!.revision = 1;
  gate.resolve();
  const backup = page.getByRole("button", {
    name: "下载本地备份",
    exact: true,
  });

  await expect(backup).toBeVisible();
  const downloading = page.waitForEvent("download");

  await backup.click();
  const download = await downloading;
  const data = JSON.parse(await readFile((await download.path())!, "utf8"));

  expect(data.elements[0].width).toBe(180);
  expect(data.elements[0].id).toBe("a");
  expect(download.suggestedFilename()).toContain("画布 A");
  expect(mock.errors).toEqual([]);
});

for (const replaced of [false, true])
  test(`temporary sync lock preserves the user's view mode and active tool after ${replaced ? "remote replacement" : "unchanged validation"}`, async ({
    page,
  }) => {
    const mock = await fixture(page);

    await page.locator(".excalidraw").evaluate((element) => {
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber$"))!
      ];

      while (fiber && !fiber.stateNode?.api) fiber = fiber.return;
      fiber.stateNode.api.setActiveTool({ type: "rectangle" });
      fiber.stateNode.api.updateScene({ appState: { viewModeEnabled: true } });
    });
    await expect
      .poll(() => editorState(page).then((state) => state.viewModeEnabled))
      .toBe(true);
    await mock.select("b");
    await mock.ready("b");
    const gate = deferred();

    mock.readGates.set("a", gate);
    await mock.select("a");
    await expect(page.locator(".save-state")).toHaveText("正在校验版本…");
    // Header status precedes editor mounting; exercise a rendered readonly preview.
    await expect
      .poll(() => editorState(page).then((state) => state.elements[0]?.id))
      .toBe("a");
    if (replaced) {
      mock.canvases.a!.revision = 1;
      mock.canvases.a!.scene.elements = [rectangle("a", 240)];
    }

    gate.resolve();
    await mock.ready("a");
    await expect
      .poll(() => editorState(page).then((state) => state.viewModeEnabled))
      .toBe(true);
    await expect
      .poll(() => editorState(page).then((state) => state.activeTool.type))
      .toBe("rectangle");
    expect(mock.counts.get("PUT /api/canvases/a") ?? 0).toBe(0);
    expect(mock.errors).toEqual([]);
  });

for (const status of [503, 409])
  test(`library save ${status} exposes recovery while the current canvas is clean`, async ({
    page,
  }) => {
    const mock = await fixture(page, true);

    await page.locator(".default-sidebar-trigger").click();
    await expect.poll(() => mock.counts.get("GET /api/library") ?? 0).toBe(1);
    await expect(
      page.getByText("正在加载素材库…", { exact: true }),
    ).toHaveCount(0);
    await page.waitForTimeout(50);
    mock.failLibrary(status);
    await page.locator(".excalidraw").evaluate(async (element) => {
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber$"))!
      ];

      while (fiber && !fiber.stateNode?.api) fiber = fiber.return;
      const app = fiber.stateNode;

      await app.api.updateLibrary({
        libraryItems: [
          {
            id: "local-library-item",
            status: "unpublished",
            created: 1,
            elements: app.api.getSceneElements(),
          },
        ],
        merge: false,
      });
    });
    await expect.poll(() => mock.counts.get("PUT /api/library") ?? 0).toBe(1);
    await expect(page.locator(".save-notice[role=alert]")).toContainText(
      status === 409 ? "保存冲突" : "保存失败",
    );
    await expect(page.locator(".save-state")).toContainText(
      status === 409 ? "保存冲突" : "保存异常",
    );
    expect(mock.counts.get("PUT /api/canvases/a") ?? 0).toBe(0);
    if (status === 503) {
      mock.failLibrary(0);
      await page.getByRole("button", { name: "重试保存", exact: true }).click();
      await expect.poll(() => mock.counts.get("PUT /api/library") ?? 0).toBe(2);
      await expect(page.locator(".save-state")).toHaveText("已保存");
    } else {
      const downloading = page.waitForEvent("download", {
        predicate: (download) =>
          download.suggestedFilename().endsWith(".excalidrawlib"),
      });

      await page
        .getByRole("button", { name: "下载本地备份", exact: true })
        .click();
      const download = await downloading;
      const data = JSON.parse(await readFile((await download.path())!, "utf8"));

      expect(data.libraryItems[0].id).toBe("local-library-item");
      await page
        .getByRole("button", { name: "加载云端版本", exact: true })
        .click();
      // Draft cleanup precedes reload; inspect the new document only after it arrives.
      await Promise.all([
        page.waitForEvent("domcontentloaded"),
        page
          .getByRole("button", { name: "丢弃并加载云端", exact: true })
          .click(),
      ]);
      await mock.ready("a");
      await page.locator(".default-sidebar-trigger").click();
      await expect.poll(() => mock.counts.get("GET /api/library") ?? 0).toBe(2);
      expect(mock.counts.get("PUT /api/library") ?? 0).toBe(1);
    }

    expect(mock.errors).toEqual([]);
  });

test("cloned sessionStorage tabs keep distinct locked draft identities and local scenes", async ({
  page,
  context,
}) => {
  const first = await fixture(page);
  const firstId = await page.evaluate(() =>
    sessionStorage.getItem("excalidraw-draft-tab"),
  );

  expect(firstId).toBeTruthy();
  const secondPage = await context.newPage();

  await secondPage.addInitScript(
    (id) => sessionStorage.setItem("excalidraw-draft-tab", id!),
    firstId,
  );
  const second = await fixture(secondPage);
  const secondId = await secondPage.evaluate(() =>
    sessionStorage.getItem("excalidraw-draft-tab"),
  );

  expect(secondId).toBeTruthy();
  expect(secondId).not.toBe(firstId);
  first.putGates.set("a", deferred());
  second.putGates.set("a", deferred());
  for (const [target, width] of [
    [page, 180],
    [secondPage, 220],
  ] as const) {
    await target.locator(".excalidraw").evaluate((element, width) => {
      let f = (element as any)[
        Object.keys(element).find((k) => k.startsWith("__reactFiber$"))!
      ];

      while (f && !f.stateNode?.api) f = f.return;
      const app = f.stateNode;

      app.api.updateScene({
        elements: [{ ...app.api.getSceneElements()[0], width, version: 2 }],
      });
    }, width);
  }

  const drafts = () =>
    page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("excalidraw-account-drafts", 1);

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      return new Promise<any[]>((resolve, reject) => {
        const tx = db.transaction("drafts");
        const values: any[] = [];
        const req = tx.objectStore("drafts").openCursor();

        req.onsuccess = () => {
          const cursor = req.result;

          if (!cursor) return;
          values.push({ key: cursor.key, value: cursor.value });
          cursor.continue();
        };

        tx.oncomplete = () => {
          db.close();
          resolve(values);
        };

        tx.onerror = () => reject(tx.error);
      });
    });

  await expect
    .poll(async () => {
      const list = await drafts();

      return list
        .filter((x) => x.key.includes("cache-user:canvas:a:tab:"))
        .map((x) => x.value.value.elements[0].width)
        .sort((a, b) => a - b);
    })
    .toEqual([180, 220]);
  expect(first.errors).toEqual([]);
  expect(second.errors).toEqual([]);
  await secondPage.close();
});

test("unloaded and loading library refuse imperative update/reset without PUT", async ({
  page,
}) => {
  const mock = await fixture(page, true);
  const attempt = () =>
    page.locator(".excalidraw").evaluate(async (element) => {
      let f = (element as any)[
        Object.keys(element).find((k) => k.startsWith("__reactFiber$"))!
      ];

      while (f && !f.stateNode?.api) f = f.return;
      const app = f.stateNode;
      const result = await app.api.updateLibrary({
        libraryItems: () => {
          throw new Error("Unloaded mutation callback must not run");
        },
      });

      await app.library.resetLibrary();

      return { result, items: await app.library.getLatestLibrary() };
    });

  expect(await attempt()).toEqual({ result: [], items: [] });
  expect(mock.counts.get("GET /api/library") ?? 0).toBe(0);
  expect(mock.counts.get("PUT /api/library") ?? 0).toBe(0);
  const gate = deferred();

  mock.readGates.set("library", gate);
  await page.locator(".default-sidebar-trigger").click();
  await expect.poll(() => mock.counts.get("GET /api/library") ?? 0).toBe(1);
  expect(await attempt()).toEqual({ result: [], items: [] });
  expect(mock.counts.get("PUT /api/library") ?? 0).toBe(0);
  gate.resolve();
  await expect(page.getByText("正在加载素材库…", { exact: true })).toHaveCount(
    0,
  );
  expect(mock.errors).toEqual([]);
});

test.describe("mobile canvas tools", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    hasTouch: true,
    viewport: { width: 1440, height: 900 },
  });

  test("mobile starts with hand, touch pans and manual selection survives cached validation", async ({
    page,
    context,
  }) => {
    const mock = await fixture(page);

    await mock.ready("a");
    await expect
      .poll(() => editorState(page).then((state) => state.activeTool.type))
      .toBe("hand");
    expect((await editorState(page)).viewModeEnabled).toBe(false);
    const before = await editorState(page);
    const box = (await page.locator(".excalidraw").boundingBox())!;
    const touch = await context.newCDPSession(page);

    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + 500, y: box.y + 350 }],
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: box.x + 600, y: box.y + 400 }],
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => editorState(page).then((state) => state.scrollX))
      .not.toBe(before.scrollX);
    expect((await editorState(page)).elements).toEqual(before.elements);
    await page.getByTestId("toolbar-selection").first().click();
    await expect
      .poll(() => editorState(page).then((state) => state.activeTool.type))
      .toBe("selection");
    await mock.select("b");
    await mock.ready("b");
    expect((await editorState(page)).activeTool.type).toBe("hand");
    const gate = deferred();

    mock.readGates.set("a", gate);
    await mock.select("a");
    await expect(page.locator(".save-state")).toHaveText("正在校验版本…");
    await expect
      .poll(() => editorState(page).then((state) => state.elements[0]?.id))
      .toBe("a");
    expect((await editorState(page)).viewModeEnabled).toBe(true);
    gate.resolve();
    await mock.ready("a");
    await expect
      .poll(() => editorState(page).then((state) => state.activeTool.type))
      .toBe("selection");
    // The hand default never enables view mode: a user can select a drawing tool.
    await page.getByTestId("toolbar-rectangle").first().click();
    await page.mouse.move(box.x + 500, box.y + 350);
    await page.mouse.down();
    await page.mouse.move(box.x + 600, box.y + 420, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(() => editorState(page).then((state) => state.elements.length))
      .toBe(2);
    expect(mock.errors).toEqual([]);
  });

  test("mobile hand survives disk-cache startup and remote content replacement", async ({
    page,
  }) => {
    const mock = await fixture(page);

    await mock.ready("a");
    const gate = deferred();

    mock.readGates.set("a", gate);
    mock.canvases.a!.revision = 1;
    mock.canvases.a!.scene.elements = [rectangle("a-new", 240)];
    await page.reload();
    await expect(page.locator(".save-state")).toHaveText("正在校验版本…");
    await expect
      .poll(() => editorState(page).then((state) => state.elements[0]?.id))
      .toBe("a");
    expect((await editorState(page)).viewModeEnabled).toBe(true);
    gate.resolve();
    await expect
      .poll(() => editorState(page).then((state) => state.elements[0]?.id))
      .toBe("a-new");
    await expect(page.locator(".save-state")).toHaveText("已保存");
    await expect
      .poll(() => editorState(page).then((state) => state.viewModeEnabled))
      .toBe(false);
    expect((await editorState(page)).activeTool.type).toBe("hand");
    expect(mock.counts.get("PUT /api/canvases/a") ?? 0).toBe(0);
    expect(mock.errors).toEqual([]);
  });
});

test("desktop tool initialization does not depend on a narrow window or touch support", async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 10 }),
  );
  const mock = await fixture(page);

  await mock.ready("a");
  // The editor may use its lasso variant on a compact desktop; neither is hand.
  expect(["selection", "lasso"]).toContain(
    (await editorState(page)).activeTool.type,
  );
  expect((await editorState(page)).viewModeEnabled).toBe(false);
  expect(mock.errors).toEqual([]);
});
