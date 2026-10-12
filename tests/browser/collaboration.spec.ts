import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { editorState } from "./fixtures";
import { currentRelease } from "../../src/data/releases";
import { announcementKey } from "../../src/lib/releaseProgress";

test.skip(
  !process.env.COLLABORATION_LIVE_TEST,
  "需要隔离的真实 Node 或 Worker 服务；不使用 API mocks",
);

async function account(browser: Browser, baseURL: string) {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 },
  });
  const bootstrap = await (await context.request.get("/api/bootstrap")).json();
  const email = `collab-${crypto.randomUUID()}@example.test`;
  const auth = await context.request.post(
    bootstrap.needsSetup ? "/api/setup" : "/api/register",
    {
      headers: { Origin: baseURL, "X-Requested-With": "excalidraw-demo" },
      data: { email, password: "CollaborationBrowser123!", name: "协作测试" },
    },
  );

  expect(auth.status(), await auth.text()).toBe(200);
  const user = (await auth.json()).user;

  await context.addInitScript(
    ({ key, release }) => localStorage.setItem(key, release),
    {
      key: announcementKey(user.id, currentRelease.sequence),
      release: currentRelease.id,
    },
  );
  const spaces = (await (await context.request.get("/api/workspaces")).json())
    .workspaces;
  const canvases = (
    await (
      await context.request.get(`/api/workspaces/${spaces[0].id}/canvases`)
    ).json()
  ).canvases;

  return { context, user, email, id: canvases[0].id };
}

async function call(
  context: BrowserContext,
  baseURL: string,
  id: string,
  route: string,
  data?: unknown,
  method = data === undefined ? "GET" : "POST",
) {
  const response = await context.request.fetch(
    `/api/canvases/${id}/collaboration/${route}`,
    {
      method,
      headers: { Origin: baseURL, "X-Requested-With": "excalidraw-demo" },
      ...(data === undefined ? {} : { data }),
    },
  );

  expect(response.status(), await response.text()).toBe(200);

  return response.json();
}

async function open(page: Page, path: string, editable: boolean) {
  await page.goto(path);
  await expect(page.locator(".excalidraw")).toBeVisible();
  await expect
    .poll(() => editorState(page).then((state) => state.viewModeEnabled))
    .toBe(!editable);
  if (editable)
    await expect(
      page.getByRole("status").filter({ hasText: /^已保存$/ }),
    ).toBeVisible();
}

async function draw(page: Page, x = 400) {
  await page.getByTestId("toolbar-rectangle").first().click();
  await page.mouse.move(x, 300);
  await page.mouse.down();
  await page.mouse.move(x + 110, 380, { steps: 5 });
  await page.mouse.up();
}

test("旧画布的已保存浏览器缓存迁入协作后正常解锁，并在重开时复用新版本", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);

  try {
    const saved = await owner.context.request.put(`/api/canvases/${owner.id}`, {
      headers: { Origin: baseURL!, "X-Requested-With": "excalidraw-demo" },
      data: {
        revision: 0,
        scene: {
          elements: [
            {
              id: "legacy-shape",
              type: "rectangle",
              x: 200,
              y: 200,
              width: 100,
              height: 80,
              angle: 0,
              version: 1,
              versionNonce: 10,
              isDeleted: false,
              index: "a0",
            },
          ],
          appState: { viewBackgroundColor: "#ffffff" },
          files: {},
        },
      },
    });

    expect(saved.status(), await saved.text()).toBe(200);
    const legacy = (
      await (
        await owner.context.request.get(`/api/canvases/${owner.id}`)
      ).json()
    ).canvas;

    expect(legacy.syncMode).toBe("legacy");
    expect(legacy.revision).toBe(1);
    const page = await owner.context.newPage();

    // Seed the real browser's old disposable cache without loading the new editor yet.
    await page.goto("/api/bootstrap");
    await page.evaluate(
      async ({ ownerId, canvas }) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("excalidraw-confirmed-cache", 1);

          request.onupgradeneeded = () =>
            request.result.createObjectStore("snapshots", { keyPath: "key" });
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });

        try {
          await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction("snapshots", "readwrite");

            transaction.objectStore("snapshots").put({
              key: JSON.stringify([1, ownerId, "canvas", canvas.id]),
              value: canvas,
              revision: canvas.revision,
              bytes: new TextEncoder().encode(JSON.stringify(canvas))
                .byteLength,
              accessedAt: Date.now(),
            });
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error);
          });
        } finally {
          database.close();
        }
      },
      { ownerId: owner.user.id, canvas: legacy },
    );
    await open(page, "/", true);
    await expect
      .poll(() =>
        editorState(page).then((state) =>
          state.elements.map((element: { id: string }) => element.id),
        ),
      )
      .toEqual(["legacy-shape"]);
    const migrated = (
      await (
        await owner.context.request.get(`/api/canvases/${owner.id}`)
      ).json()
    ).canvas;

    expect(migrated.syncMode).toBe("collaborative");
    expect(migrated.revision).toBe(0);
    await open(page, "/", true);
    await expect
      .poll(() => editorState(page).then((state) => state.elements.length))
      .toBe(1);
  } finally {
    await owner.context.close();
  }
});

test("主画布的分享面板发布固定版本，并向已有账号提供共享入口", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);
  const invited = await account(browser, baseURL!);
  const page = await owner.context.newPage();
  const guestContext = await browser.newContext({ baseURL });

  try {
    await open(page, "/", true);
    await draw(page, 650);
    await expect
      .poll(() => editorState(page).then((state) => state.elements.length))
      .toBe(1);
    const toolbar = page.locator(".App-toolbar");
    const host = page.locator(".canvas-host");
    const bounds = await toolbar.boundingBox();
    const canvasBounds = await host.boundingBox();

    expect(bounds!.y).toBeGreaterThan(
      canvasBounds!.y + canvasBounds!.height / 2,
    );
    await page.getByRole("button", { name: "分享", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "分享画布" });

    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("查看方式")).toHaveValue("latest");
    await expect(dialog.getByLabel("要求登录")).toBeChecked();
    await dialog.getByLabel("固定版本名称").fill("面板发布测试");
    await dialog.getByRole("button", { name: "发布当前已保存内容" }).click();
    await expect(
      dialog.getByText("面板发布测试 ·", { exact: false }).last(),
    ).toBeVisible();
    await dialog.getByLabel("查看方式").selectOption("fixed");
    await dialog.getByLabel("要求登录").uncheck();
    await dialog.getByRole("button", { name: "生成链接" }).click();
    const link = dialog.getByLabel("新分享链接");

    await expect(link).toHaveValue(/\/share\/.*#/);
    const guest = await guestContext.newPage();

    await open(guest, await link.inputValue(), false);
    await expect
      .poll(() => editorState(guest).then((state) => state.elements.length))
      .toBe(1);
    await dialog.getByLabel("权限", { exact: true }).selectOption("editor");
    await dialog.getByLabel("邀请账号邮箱").fill(invited.email);
    await dialog.getByRole("button", { name: "邀请 / 更新权限" }).click();
    await expect(
      dialog.getByText("协作测试 · 编辑者", { exact: false }),
    ).toBeVisible();
    const memberPage = await invited.context.newPage();

    await open(memberPage, "/", true);
    await memberPage.getByRole("button", { name: "与我共享 · 刷新" }).click();
    await expect(memberPage.locator(`a[href='/c/${owner.id}']`)).toBeVisible();
    await memberPage.locator(`a[href='/c/${owner.id}']`).click();
    await expect
      .poll(() =>
        editorState(memberPage).then((state) => state.elements.length),
      )
      .toBe(1);
  } finally {
    await owner.context.close();
    await invited.context.close();
    await guestContext.close();
  }
});

test("真实房间：双会话合并、远程更新不回传、撤销隔离及本地场景替换", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);
  const first = await owner.context.newPage();
  const errors: string[] = [];

  first.on("pageerror", (error) => errors.push(error.message));
  try {
    await open(first, `/c/${owner.id}`, true);
    const link = await call(owner.context, baseURL!, owner.id, "links", {
      role: "editor",
      requireLogin: false,
    });
    const guestContext = await browser.newContext({
      baseURL,
      viewport: { width: 1440, height: 900 },
    });
    const second = await guestContext.newPage();

    second.on("pageerror", (error) => errors.push(error.message));
    try {
      await open(second, link.path, true);
      await draw(first, 350);
      await expect
        .poll(() => editorState(second).then((state) => state.elements.length))
        .toBe(1);
      await draw(second, 600);
      await expect
        .poll(() => editorState(first).then((state) => state.elements.length))
        .toBe(2);
      await expect
        .poll(
          async () =>
            (await call(owner.context, baseURL!, owner.id, "view")).seq,
        )
        .toBe(2);
      await first.keyboard.press("Control+z");
      await expect
        .poll(() => editorState(second).then((state) => state.elements.length))
        .toBe(1);
      const remaining = await editorState(second);

      expect(remaining.elements[0].x).toBeGreaterThan(500);
      // File import/reset replaces the array instead of emitting tombstones.
      await first.locator(".excalidraw").evaluate((node) => {
        let fiber = (node as any)[
          Object.keys(node).find((key) => key.startsWith("__reactFiber$"))!
        ];

        while (fiber && !fiber.stateNode?.api?.getSceneElements)
          fiber = fiber.return;
        fiber.stateNode.api.updateScene({
          elements: [],
          captureUpdate: "IMMEDIATELY",
        });
      });
      await expect
        .poll(() => editorState(second).then((state) => state.elements.length))
        .toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await guestContext.close();
    }
  } finally {
    await owner.context.close();
  }
});

test("真实三种查看模式：实时跟随、最新手动刷新、固定版本重开保持不变", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);
  const first = await owner.context.newPage();
  const guests: BrowserContext[] = [];

  try {
    await open(first, `/c/${owner.id}`, true);
    await draw(first);
    await expect
      .poll(
        async () => (await call(owner.context, baseURL!, owner.id, "view")).seq,
      )
      .toBe(1);
    await call(owner.context, baseURL!, owner.id, "versions", {
      id: "fixed-browser",
      label: "固定测试",
    });
    const pages: Record<string, Page> = {};
    const sockets: Record<string, number> = {};
    const privateRequests: string[] = [];

    for (const mode of ["live", "latest", "fixed"]) {
      const link = await call(owner.context, baseURL!, owner.id, "links", {
        role: "viewer",
        viewMode: mode,
        requireLogin: false,
        ...(mode === "fixed" ? { snapshotId: "fixed-browser" } : {}),
      });
      const context = await browser.newContext({
        baseURL,
        viewport: { width: 1440, height: 900 },
      });

      guests.push(context);
      pages[mode] = await context.newPage();
      sockets[mode] = 0;
      pages[mode]!.on("websocket", () => {
        sockets[mode] = (sockets[mode] ?? 0) + 1;
      });
      pages[mode]!.on("request", (request) => {
        if (
          /\/api\/(library|user-settings|workspaces)(?:[/?]|$)/.test(
            new URL(request.url()).pathname,
          )
        )
          privateRequests.push(request.url());
      });
      await open(pages[mode]!, link.path, false);
      await expect
        .poll(() =>
          editorState(pages[mode]!).then((state) => state.elements.length),
        )
        .toBe(1);
    }

    await draw(first, 600);
    await expect
      .poll(() =>
        editorState(pages.live!).then((state) => state.elements.length),
      )
      .toBe(2);
    expect((await editorState(pages.latest!)).elements.length).toBe(1);
    expect((await editorState(pages.fixed!)).elements.length).toBe(1);
    for (const mode of ["latest", "fixed"]) {
      await pages[mode]!.evaluate(() => {
        window.dispatchEvent(new Event("offline"));
        window.dispatchEvent(new Event("online"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }

    expect(sockets).toEqual({ live: 1, latest: 0, fixed: 0 });
    expect(privateRequests).toEqual([]);
    expect((await editorState(pages.latest!)).elements.length).toBe(1);
    await pages.latest!.getByRole("button", { name: "刷新最新版" }).click();
    await expect
      .poll(() =>
        editorState(pages.latest!).then((state) => state.elements.length),
      )
      .toBe(2);
    await pages.fixed!.reload();
    await expect
      .poll(() =>
        editorState(pages.fixed!).then((state) => state.elements.length),
      )
      .toBe(1);
  } finally {
    for (const context of guests) await context.close();
    await owner.context.close();
  }
});

test("离线编辑重连后合并；权限撤销后停止读取和编辑", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);
  const first = await owner.context.newPage();
  const guestContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 },
  });
  const second = await guestContext.newPage();

  try {
    await open(first, `/c/${owner.id}`, true);
    const link = await call(owner.context, baseURL!, owner.id, "links", {
      role: "editor",
      requireLogin: false,
    });

    await open(second, link.path, true);
    await guestContext.setOffline(true);
    await draw(second, 600);
    await expect(
      second.getByRole("status").filter({ hasText: "离线" }).first(),
    ).toBeVisible();
    await draw(first, 350);
    await expect
      .poll(
        async () =>
          (await call(owner.context, baseURL!, owner.id, "view")).scene.elements
            .length,
      )
      .toBe(1);
    await guestContext.setOffline(false);
    await expect
      .poll(() => editorState(first).then((state) => state.elements.length), {
        timeout: 15000,
      })
      .toBe(2);
    await expect
      .poll(() => editorState(second).then((state) => state.elements.length))
      .toBe(2);
    await call(
      owner.context,
      baseURL!,
      owner.id,
      "links",
      { id: link.id },
      "DELETE",
    );
    await expect(
      second.getByRole("status").filter({ hasText: "访问已失效" }),
    ).toBeVisible();
    await expect
      .poll(() => editorState(second).then((state) => state.viewModeEnabled))
      .toBe(true);
    expect(
      (await call(owner.context, baseURL!, owner.id, "view")).scene.elements
        .length,
    ).toBe(2);
  } finally {
    await guestContext.close();
    await owner.context.close();
  }
});

test("同账号独立浏览器并发编辑共享一张画布；只移动视角不保存", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);
  const other = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 },
    storageState: await owner.context.storageState(),
  });
  const first = await owner.context.newPage(),
    second = await other.newPage();

  try {
    await Promise.all([
      open(first, `/c/${owner.id}`, true),
      open(second, `/c/${owner.id}`, true),
    ]);
    await Promise.all([draw(first, 350), draw(second, 650)]);
    await expect
      .poll(() => editorState(first).then((state) => state.elements.length))
      .toBe(2);
    await expect
      .poll(() => editorState(second).then((state) => state.elements.length))
      .toBe(2);
    const before = (await call(owner.context, baseURL!, owner.id, "view")).seq;

    await first.mouse.move(900, 600);
    await first.mouse.wheel(0, 240);
    await expect
      .poll(() => editorState(first).then((state) => state.scrollY))
      .not.toBe(0);
    expect((await call(owner.context, baseURL!, owner.id, "view")).seq).toBe(
      before,
    );
  } finally {
    await other.close();
    await owner.context.close();
  }
});

test("同一元素被另一会话更新后，撤销不会回滚对方修改", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);
  const first = await owner.context.newPage();
  const other = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 },
    storageState: await owner.context.storageState(),
  });
  const second = await other.newPage();

  try {
    await open(first, `/c/${owner.id}`, true);
    await draw(first, 350);
    await expect
      .poll(
        async () =>
          (await call(owner.context, baseURL!, owner.id, "view")).scene.elements
            .length,
      )
      .toBe(1);
    await open(second, `/c/${owner.id}`, true);
    await second.getByTestId("toolbar-selection").first().click();
    await second.locator(".excalidraw").evaluate((node) => {
      let fiber = (node as any)[
        Object.keys(node).find((key) => key.startsWith("__reactFiber$"))!
      ];

      while (fiber && !fiber.stateNode?.api?.getSceneElements)
        fiber = fiber.return;
      const app = fiber.stateNode;

      app.api.mutateElement(app.api.getSceneElements()[0], { x: 650 });
    });
    await expect
      .poll(() => editorState(first).then((state) => state.elements[0]?.x))
      .toBeGreaterThan(550);
    const saved = (await call(owner.context, baseURL!, owner.id, "view")).scene
      .elements[0];

    await first.locator(".excalidraw").click({ position: { x: 1000, y: 600 } });
    await first.keyboard.press("Control+z");
    await expect
      .poll(() => editorState(first).then((state) => state.elements.length))
      .toBe(1);
    expect((await editorState(first)).elements[0].x).toBe(saved.x);
  } finally {
    await other.close();
    await owner.context.close();
  }
});
