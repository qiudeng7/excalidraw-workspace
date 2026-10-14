import { readFile } from "node:fs/promises";
import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
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

test("权限降级后的旧草稿可下载，取消保留，确认放弃后按当前权限重读", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);
  const invited = await account(browser, baseURL!);
  const page = await invited.context.newPage();

  try {
    await call(owner.context, baseURL!, owner.id, "members", {
      email: invited.email,
      role: "editor",
      viewMode: "live",
    });
    await open(page, `/c/${owner.id}`, true);
    await page.route("**/collaboration/update", (route) => route.abort());
    await draw(page);
    await expect(
      page.getByRole("status").filter({ hasText: "离线" }),
    ).toBeVisible();
    await call(owner.context, baseURL!, owner.id, "members", {
      email: invited.email,
      role: "viewer",
      viewMode: "live",
    });
    page.once("dialog", (dialog) => dialog.accept());
    await page.reload();
    const discard = page.getByRole("button", { name: "放弃草稿并重新读取" });

    await expect(discard).toBeVisible();
    await expect(
      page.getByText("发现权限变更前尚未同步的草稿", { exact: false }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(discard).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const backup = async () => {
      const waiting = page.waitForEvent("download");

      await page.getByRole("button", { name: "下载本地备份" }).click();
      const download = await waiting;

      return JSON.parse(await readFile((await download.path())!, "utf8"));
    };
    const first = await backup();

    expect(
      first.elements.filter((element: any) => !element.isDeleted),
    ).toHaveLength(1);
    await discard.click();
    const confirmation = page.getByRole("dialog", { name: "放弃未同步草稿" });

    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText("无法撤销");
    await confirmation
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(discard).toBeVisible();
    expect((await backup()).elements).toEqual(first.elements);
    await discard.click();
    await confirmation
      .getByRole("button", { name: "放弃并重新读取", exact: true })
      .click();
    await expect(discard).toBeHidden();
    await expect(
      page.getByRole("status").filter({ hasText: /^实时查看$/ }),
    ).toBeVisible();
    await expect
      .poll(() => editorState(page).then((state) => state.viewModeEnabled))
      .toBe(true);
    await expect
      .poll(() => editorState(page).then((state) => state.elements.length))
      .toBe(0);
    expect((await call(owner.context, baseURL!, owner.id, "view")).seq).toBe(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.unroute("**/collaboration/update");
    await call(owner.context, baseURL!, owner.id, "members", {
      email: invited.email,
      role: "editor",
      viewMode: "live",
    });
    await open(page, `/c/${owner.id}`, true);
    await draw(page);
    await expect(
      page.getByRole("status").filter({ hasText: /^已保存$/ }),
    ).toBeVisible();
    expect(
      (await call(owner.context, baseURL!, owner.id, "view")).scene.elements,
    ).toHaveLength(1);
  } finally {
    await invited.context.close();
    await owner.context.close();
  }
});

test("标签页保留协作画布的撤销历史，后台远端更新后清空旧历史", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);
  const other = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 },
  });

  try {
    const original = (
      await (
        await owner.context.request.get(`/api/canvases/${owner.id}`)
      ).json()
    ).canvas;
    const catalog = await (
      await owner.context.request.get(
        `/api/workspaces/${original.workspaceId}/canvases`,
      )
    ).json();
    const created = await owner.context.request.post(
      `/api/workspaces/${original.workspaceId}/canvases`,
      {
        headers: { Origin: baseURL!, "X-Requested-With": "excalidraw-demo" },
        data: { name: "第二张画布", catalogRevision: catalog.catalogRevision },
      },
    );

    expect(created.status(), await created.text()).toBe(200);
    const second = (await created.json()).canvas;

    await call(owner.context, baseURL!, owner.id, "access");
    await call(owner.context, baseURL!, second.id, "access");
    const page = await owner.context.newPage();

    await open(page, "/", true);
    await page.locator(`[data-canvas-id="${owner.id}"] .canvas-name`).click();
    await expect(page.locator(`#canvas-tab-${owner.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.getByRole("status").filter({ hasText: /^已保存$/ }),
    ).toBeVisible();
    // Main workspace has a sidebar and a properties panel to its right.
    await draw(page, 700);
    await expect
      .poll(() =>
        editorState(page).then(
          (state) =>
            state.elements.filter((element: any) => !element.isDeleted).length,
        ),
      )
      .toBe(1);
    await expect(
      page.getByRole("status").filter({ hasText: /^已保存$/ }),
    ).toBeVisible();
    await page.getByTestId("toolbar-ellipse").click();
    await expect
      .poll(() => editorState(page).then((state) => state.activeTool.type))
      .toBe("ellipse");
    await page.locator(`[data-canvas-id="${second.id}"] .canvas-name`).click();
    await expect(
      page.getByRole("tab", { name: "第二张画布", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("status").filter({ hasText: /^已保存$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "撤销", exact: true }),
    ).toBeDisabled();
    await page.locator(`#canvas-tab-${owner.id}`).click();
    await expect
      .poll(() => editorState(page).then((state) => state.activeTool.type))
      .toBe("ellipse");
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
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect
      .poll(() =>
        editorState(page).then(
          (state) =>
            state.elements.filter((element: any) => !element.isDeleted).length,
        ),
      )
      .toBe(1);
    await expect(
      page.getByRole("status").filter({ hasText: /^已保存$/ }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "第二张画布", exact: true }).click();
    const login = await other.request.post("/api/login", {
      headers: { Origin: baseURL!, "X-Requested-With": "excalidraw-demo" },
      data: { email: owner.email, password: "CollaborationBrowser123!" },
    });

    expect(login.status(), await login.text()).toBe(200);
    const remote = await other.newPage();

    await open(remote, `/c/${owner.id}`, true);
    await draw(remote, 650);
    await expect(
      remote.getByRole("status").filter({ hasText: /^已保存$/ }),
    ).toBeVisible();
    await expect
      .poll(() =>
        editorState(remote).then(
          (state) =>
            state.elements.filter((element: any) => !element.isDeleted).length,
        ),
      )
      .toBe(2);
    await expect
      .poll(() =>
        editorState(page).then(
          (state) =>
            state.elements.filter((element: any) => !element.isDeleted).length,
        ),
      )
      .toBe(0);
    await page.locator(`#canvas-tab-${owner.id}`).click();
    await expect
      .poll(() =>
        editorState(page).then(
          (state) =>
            state.elements.filter((element: any) => !element.isDeleted).length,
        ),
      )
      .toBe(2);
    await expect(
      page.getByRole("button", { name: "撤销", exact: true }),
    ).toBeDisabled();
  } finally {
    await other.close();
    await owner.context.close();
  }
});

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
    // Explicit activation now replaces the former implicit GET migration.
    await call(owner.context, baseURL!, owner.id, "access");
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
    await dialog.getByRole("button", { name: "分享链接", exact: true }).click();
    await expect(dialog.getByLabel("要求登录")).toBeChecked();
    await dialog.getByRole("button", { name: "固定版本", exact: true }).click();
    await dialog.getByLabel("固定版本名称").fill("面板发布测试");
    await dialog
      .getByRole("button", { name: "发布固定版本", exact: true })
      .click();
    await expect(
      dialog.getByText("面板发布测试", { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "分享链接", exact: true }).click();
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
    await dialog.getByRole("button", { name: "邀请成员", exact: true }).click();
    await dialog.getByLabel("权限", { exact: true }).selectOption("editor");
    await dialog.getByLabel("邀请账号邮箱").fill(invited.email);
    await dialog.getByRole("button", { name: "邀请 / 更新权限" }).click();
    await expect(
      dialog
        .getByRole("listitem")
        .filter({ hasText: "协作测试" })
        .getByText("可编辑"),
    ).toBeVisible();
    const memberPage = await invited.context.newPage();

    await open(memberPage, "/", true);
    // Login loads invitations even while the recipient's own canvas is still solo.
    await memberPage
      .getByRole("button", { name: "与我共享", exact: true })
      .click();
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
  let firstUpdates = 0;
  let secondUpdates = 0;

  first.on("pageerror", (error) => errors.push(error.message));
  first.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/collaboration/update")
    )
      firstUpdates++;
  });
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
    second.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/collaboration/update")
      )
        secondUpdates++;
    });
    try {
      await open(second, link.path, true);
      await draw(first, 350);
      await expect
        .poll(() => editorState(second).then((state) => state.elements.length))
        .toBe(1);
      await expect(
        first.getByRole("status").filter({ hasText: /^已保存$/ }),
      ).toBeVisible();
      await first.waitForLoadState("networkidle");
      await expect(
        second.getByRole("status").filter({ hasText: /^已保存$/ }),
      ).toBeVisible();
      expect(
        secondUpdates,
        "receiving another editor's drawing must not write",
      ).toBe(0);
      const beforeRemote = firstUpdates;

      await draw(second, 600);
      await expect
        .poll(() => editorState(first).then((state) => state.elements.length))
        .toBe(2);
      await expect(
        second.getByRole("status").filter({ hasText: /^已保存$/ }),
      ).toBeVisible();
      // Let the real update request and resulting render/debounce work settle
      // before measuring absence of echo writes. Dragging can commit several times.
      await second.waitForLoadState("networkidle");
      await expect(
        first.getByRole("status").filter({ hasText: /^已保存$/ }),
      ).toBeVisible();
      expect(
        firstUpdates,
        "remote changes must not echo through the first editor",
      ).toBe(beforeRemote);
      expect(
        (await call(owner.context, baseURL!, owner.id, "view")).seq,
      ).toBeGreaterThanOrEqual(2);
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

test("单人编辑不建房，第二个浏览器加入时接续首位在途保存并保留双方修改", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);
  const first = await owner.context.newPage();
  let release!: () => void;
  let intercepted!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    intercepted = resolve;
  });
  let secondContext: BrowserContext | undefined;

  try {
    await open(first, "/", true);
    const read = async () =>
      (
        await (
          await owner.context.request.get(`/api/canvases/${owner.id}`)
        ).json()
      ).canvas;

    expect((await read()).syncMode).toBe("legacy");
    await Promise.all([
      first.waitForResponse(
        (response) =>
          response.url().endsWith(`/canvases/${owner.id}/presence`) &&
          response.request().method() === "POST",
      ),
      first.reload(),
    ]);
    await expect
      .poll(() => editorState(first).then((state) => state.viewModeEnabled))
      .toBe(false);
    expect((await read()).syncMode).toBe("legacy");
    await first.route(`**/api/canvases/${owner.id}`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      intercepted();
      await waiting;
      await route.continue();
    });
    await draw(first, 650);
    await expect
      .poll(() => editorState(first).then((state) => state.elements.length))
      .toBe(1);
    await entered;
    secondContext = await browser.newContext({
      baseURL,
      viewport: { width: 1440, height: 900 },
      storageState: await owner.context.storageState(),
    });
    const second = await secondContext.newPage();

    await open(second, "/", true);
    await expect
      .poll(async () => (await read()).syncMode)
      .toBe("collaborative");
    release();
    await expect(first.locator(".collaboration-editor")).toBeVisible();
    await expect(second.locator(".collaboration-editor")).toBeVisible();
    await expect
      .poll(() => editorState(first).then((state) => state.elements.length))
      .toBe(1);
    await expect
      .poll(() => editorState(second).then((state) => state.elements.length))
      .toBe(1);
    await draw(second, 950);
    await expect
      .poll(() => editorState(first).then((state) => state.elements.length))
      .toBe(2);
    await expect
      .poll(
        async () =>
          (await read()).scene.elements.filter(
            (element: { isDeleted?: boolean }) => !element.isDeleted,
          ).length,
      )
      .toBe(2);
    await first.reload();
    await expect(first.locator(".collaboration-editor")).toBeVisible();
    await expect
      .poll(() => editorState(first).then((state) => state.elements.length))
      .toBe(2);
  } finally {
    release?.();
    await secondContext?.close();
    await owner.context.close();
  }
});

test("单人文字的输入法组合与未失焦内容在协作升级前完整提交", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);
  const first = await owner.context.newPage();
  let secondContext: BrowserContext | undefined;

  try {
    await open(first, "/", true);
    await first.getByTestId("toolbar-text").first().click();
    await first.mouse.click(700, 360);
    const textarea = first.locator(".excalidraw-wysiwyg");

    await expect(textarea).toBeVisible();
    await textarea.evaluate((element) =>
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
    await textarea.fill("升级时仍在输入的完整文字");
    secondContext = await browser.newContext({
      baseURL,
      viewport: { width: 1440, height: 900 },
      storageState: await owner.context.storageState(),
    });
    const second = await secondContext.newPage();

    await open(second, "/", true);
    await expect(second.locator(".collaboration-editor")).toBeVisible();
    await first.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(textarea).toBeVisible();
    await textarea.evaluate((element) =>
      element.dispatchEvent(
        new CompositionEvent("compositionend", {
          bubbles: true,
          data: "完整文字",
        }),
      ),
    );
    await expect(first.locator(".collaboration-editor")).toBeVisible();
    await expect
      .poll(() =>
        editorState(second).then((state) =>
          state.elements
            .map((element: { text?: string }) => element.text)
            .filter(Boolean),
        ),
      )
      .toEqual(["升级时仍在输入的完整文字"]);
  } finally {
    await secondContext?.close();
    await owner.context.close();
  }
});

test("移动端协作画布解锁使用抓手，手动选择工具后远端更新和重连保持选择", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);

  // These regressions target the collaboration wrapper, not lazy activation.
  await call(owner.context, baseURL!, owner.id, "access");
  const other = await browser.newContext({ baseURL });
  let releaseView!: () => void;
  const viewGate = new Promise<void>((resolve) => {
    releaseView = resolve;
  });

  await owner.context.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      get: () =>
        "Mozilla/5.0 (Linux; Android 15; Tablet) Chrome/130 Safari/537.36",
    });
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
  });
  const page = await owner.context.newPage();
  const errors: string[] = [];
  let liveSocket: WebSocketRoute | undefined;
  let socketConnections = 0;

  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.routeWebSocket(
      `**/api/canvases/${owner.id}/realtime`,
      (socket) => {
        liveSocket = socket;
        socketConnections++;
        socket.connectToServer();
      },
    );
    await page.route(
      `**/api/canvases/${owner.id}/collaboration/view`,
      async (route) => {
        await viewGate;
        await route.continue();
      },
    );
    await page.goto("/");
    await expect(page.locator(".excalidraw")).toBeVisible();
    await expect
      .poll(() => editorState(page).then((state) => state.activeTool.type))
      .toBe("hand");
    expect((await editorState(page)).viewModeEnabled).toBe(true);
    releaseView();
    await expect
      .poll(() => editorState(page).then((state) => state.viewModeEnabled))
      .toBe(false);
    expect((await editorState(page)).activeTool.type).toBe("hand");
    await page.getByTestId("toolbar-selection").first().click();
    const link = await call(owner.context, baseURL!, owner.id, "links", {
      role: "editor",
      requireLogin: false,
    });
    const remote = await other.newPage();

    await open(remote, link.path, true);
    // Desktop retains its normal pointer default.
    expect((await editorState(remote)).activeTool.type).toBe("selection");
    await draw(remote);
    await expect
      .poll(() => editorState(page).then((state) => state.elements.length))
      .toBe(1);
    expect((await editorState(page)).activeTool.type).toBe("selection");
    await page.getByRole("button", { name: "新建画布", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建画布", exact: true });

    await create.getByLabel("画布名称").fill("工具切换测试");
    await create.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.locator(".canvas-name[aria-current=page]")).toHaveText(
      "工具切换测试",
    );
    await expect
      .poll(() => editorState(page).then((state) => state.viewModeEnabled))
      .toBe(false);
    expect((await editorState(page)).activeTool.type).toBe("hand");
    await page.locator(`[data-canvas-id="${owner.id}"] .canvas-name`).click();
    await expect
      .poll(() => editorState(page).then((state) => state.elements.length))
      .toBe(1);
    await expect
      .poll(() => editorState(page).then((state) => state.viewModeEnabled))
      .toBe(false);
    expect((await editorState(page)).activeTool.type).toBe("selection");
    // Browser offline emulation need not close an existing WebSocket. Close
    // the forwarded real connection explicitly and observe a fresh handshake.
    const connectionsBefore = socketConnections;

    expect(liveSocket).toBeDefined();
    await liveSocket!.close({
      code: 1012,
      reason: "tool reconnect regression",
    });
    await expect
      .poll(() => socketConnections)
      .toBeGreaterThan(connectionsBefore);
    await expect(
      page.getByRole("status").filter({ hasText: /^已保存$/ }),
    ).toBeVisible();
    expect((await editorState(page)).activeTool.type).toBe("selection");
    await draw(page, 650);
    await expect
      .poll(() => editorState(remote).then((state) => state.elements.length))
      .toBe(2);
    expect(errors).toEqual([]);
  } finally {
    releaseView();
    await owner.context.close();
    await other.close();
  }
});

test("协作编辑器即时应用 Ctrl 多选开关，独立选择不写入共享场景", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);

  // These regressions target the collaboration wrapper, not lazy activation.
  await call(owner.context, baseURL!, owner.id, "access");
  const guestContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 },
  });

  try {
    const page = await owner.context.newPage();

    await open(page, "/", true);
    await draw(page, 600);
    await draw(page, 850);
    await expect
      .poll(() => editorState(page).then((state) => state.elements.length))
      .toBe(2);
    const link = await call(owner.context, baseURL!, owner.id, "links", {
      role: "editor",
      requireLogin: false,
    });
    const guest = await guestContext.newPage();

    await open(guest, link.path, true);
    await expect
      .poll(() => editorState(guest).then((state) => state.elements.length))
      .toBe(2);
    const before = await call(owner.context, baseURL!, owner.id, "view");
    const clickShape = async (
      target: Page,
      index: number,
      modifier?: "Control" | "Shift",
    ) => {
      const state = await editorState(target);
      const element = state.elements[index];
      const box = (await target
        .locator(".excalidraw canvas")
        .last()
        .boundingBox())!;

      if (modifier) await target.keyboard.down(modifier);
      await target.mouse.click(
        box.x +
          (element.x + element.width / 2 + state.scrollX) * state.zoom.value,
        box.y + (element.y + state.scrollY) * state.zoom.value,
      );
      if (modifier) await target.keyboard.up(modifier);
    };
    const exercise = async (target: Page) => {
      // Clicking the active selection toolbar button toggles the native lasso.
      if ((await editorState(target)).activeTool.type !== "selection")
        await target.getByTestId("toolbar-selection").first().click();
      await expect
        .poll(() => editorState(target).then((state) => state.activeTool.type))
        .toBe("selection");
      await clickShape(target, 0);
      await expect
        .poll(() =>
          editorState(target).then(
            (state) => Object.keys(state.selectedElementIds).length,
          ),
        )
        .toBe(1);
      await clickShape(target, 1, "Control");
      await expect
        .poll(() =>
          editorState(target).then(
            (state) => Object.keys(state.selectedElementIds).length,
          ),
        )
        .toBe(2);
      await clickShape(target, 0, "Control");
      await expect
        .poll(() =>
          editorState(target).then(
            (state) => Object.keys(state.selectedElementIds).length,
          ),
        )
        .toBe(1);
    };

    await exercise(page);
    await exercise(guest);
    expect((await call(owner.context, baseURL!, owner.id, "view")).seq).toBe(
      before.seq,
    );
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });

    await dialog.getByRole("tab", { name: "编辑器", exact: true }).click();
    const checkbox = dialog.getByRole("checkbox", {
      name: "Ctrl 点击多选",
      exact: true,
    });

    await expect(checkbox).toBeChecked();
    await checkbox.locator("..").click();
    await expect
      .poll(
        async () =>
          (await (await owner.context.request.get("/api/user-settings")).json())
            .settings.features.ctrlMultiSelect,
      )
      .toBe(false);
    await dialog.getByRole("button", { name: "关闭设置" }).click();
    await clickShape(page, 0, "Control");
    await expect
      .poll(() =>
        editorState(page).then(
          (state) => Object.keys(state.selectedElementIds).length,
        ),
      )
      .toBe(1);
    await clickShape(page, 1, "Shift");
    await expect
      .poll(() =>
        editorState(page).then(
          (state) => Object.keys(state.selectedElementIds).length,
        ),
      )
      .toBe(2);
    expect((await call(owner.context, baseURL!, owner.id, "view")).seq).toBe(
      before.seq,
    );
  } finally {
    await guestContext.close();
    await owner.context.close();
  }
});

test("分享面板引导发布固定版本，复制被拒绝时保留手动复制入口", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);
  const page = await owner.context.newPage();

  try {
    await open(page, "/", true);
    await page.getByRole("button", { name: "分享", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "分享画布" });

    await dialog.getByLabel("查看方式").selectOption("fixed");
    await expect(
      dialog.getByRole("button", { name: "邀请 / 更新权限" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "先发布一个固定版本" }).click();
    await expect(
      dialog.getByRole("button", { name: "固定版本", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await dialog.getByLabel("固定版本名称").fill("供评审的固定版本");
    await dialog
      .getByRole("button", { name: "发布固定版本", exact: true })
      .click();
    await expect(
      dialog.getByText("供评审的固定版本", { exact: true }),
    ).toBeVisible();
    const linksSection = dialog.getByRole("button", {
      name: "分享链接",
      exact: true,
    });

    await linksSection.focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByLabel("固定版本")).not.toHaveValue("");
    await dialog.getByRole("button", { name: "生成链接" }).click();
    const link = dialog.getByLabel("新分享链接");

    await expect(link).toHaveValue(/\/share\/.*#/);
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: () =>
          Promise.reject(
            new DOMException("Clipboard denied", "NotAllowedError"),
          ),
      });
    });
    await dialog.getByRole("button", { name: "复制链接" }).click();
    await expect(dialog.getByRole("status")).toContainText(
      "请复制已选中的链接",
    );
    await expect(link).toBeFocused();
    expect(
      await link.evaluate(
        (node: HTMLInputElement) => node.selectionEnd! - node.selectionStart!,
      ),
    ).toBe((await link.inputValue()).length);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "分享", exact: true }),
    ).toBeFocused();
  } finally {
    await owner.context.close();
  }
});

test("富文本会话在远端胜出/删除及撤权时结束，恢复副本生成新元素且旧历史不再提交", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(60000);
  const owner = await account(browser, baseURL!);
  const first = await owner.context.newPage();

  try {
    await open(first, `/c/${owner.id}`, true);
    await first.getByTestId("toolbar-text").first().click();
    await first.mouse.click(700, 350);
    const input = first.locator(".excalidraw-wysiwyg");

    await input.pressSequentially("**original**", { delay: 10 });
    await input.press("Escape");
    const fonts = await first.evaluate(async () => {
      await document.fonts.load("16px Nunito", "original");

      return {
        loaded: document.fonts.check("16px Nunito", "original"),
        urls: performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((url) =>
            url.startsWith(`${location.origin}/editor-assets/fonts/Nunito/`),
          ),
      };
    });

    expect(fonts.loaded).toBe(true);
    expect(fonts.urls.length).toBeGreaterThan(0);
    expect((await first.request.get(fonts.urls[0]!)).status()).toBe(200);
    await expect
      .poll(async () =>
        (
          await call(owner.context, baseURL!, owner.id, "view")
        ).scene.elements.some((element: any) => element.richText),
      )
      .toBe(true);
    const link = await call(owner.context, baseURL!, owner.id, "links", {
      role: "editor",
      requireLogin: false,
    });
    const guest = await browser.newContext({
      baseURL,
      viewport: { width: 1440, height: 900 },
    });

    try {
      const second = await guest.newPage();

      await open(second, link.path, true);
      await first.mouse.dblclick(705, 355);
      await expect(input).toBeVisible();
      await input.press("End");
      await input.pressSequentially(" local");
      // Ensure a deterministic remote winner while the first editor's DOM/history stays active.
      const view = await call(owner.context, baseURL!, owner.id, "view");
      const original = view.scene.elements.find(
        (element: any) => element.type === "text",
      );

      await second.locator(".excalidraw").evaluate((node, original) => {
        const host = node as any;
        let fiber =
          host[
            Object.keys(host).find((key) => key.startsWith("__reactFiber$"))!
          ];

        while (fiber && !fiber.stateNode?.api?.getSceneElements)
          fiber = fiber.return;
        const app = fiber.stateNode;
        const richText = {
          version: 1,
          doc: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "remote", marks: [{ type: "italic" }] },
                ],
              },
            ],
          },
        };

        app.api.updateScene({
          elements: [
            {
              ...original,
              text: "remote",
              originalText: "remote",
              richText,
              version: original.version + 100,
              versionNonce: 0,
            },
          ],
          captureUpdate: "IMMEDIATELY",
        });
      }, original);
      await expect(input).toHaveCount(0);
      await expect(
        first.getByRole("button", { name: "恢复为新文字" }),
      ).toBeVisible();
      await expect
        .poll(() =>
          editorState(first).then(
            (state) => (state.elements[0] as any).originalText,
          ),
        )
        .toBe("remote");
      await first.getByRole("button", { name: "恢复为新文字" }).click();
      await expect
        .poll(() => editorState(second).then((state) => state.elements.length))
        .toBe(2);
      const recovered = (await editorState(first)).elements.find(
        (element: any) => element.id !== original.id,
      ) as any;

      expect(recovered.originalText).toContain("local");
      expect(recovered.richText.doc.content[0].content[0].marks).toEqual([
        { type: "bold" },
      ]);
      // A remote deletion also tears down the active instance; no late blur can resurrect it.
      await first.mouse.dblclick(705, 355);
      await expect(input).toBeVisible();
      const latest = (
        await call(owner.context, baseURL!, owner.id, "view")
      ).scene.elements.find((element: any) => element.id === original.id);

      await call(owner.context, baseURL!, owner.id, "update", {
        protocolVersion: 1,
        textFormatVersion: 1,
        epoch: view.epoch,
        clientId: "rich-test-deletion",
        clientSeq: 1,
        opId: crypto.randomUUID(),
        baseSeq: view.seq,
        elements: [
          {
            ...latest,
            isDeleted: true,
            version: latest.version + 100,
            versionNonce: 0,
          },
        ],
      });
      await expect(input).toHaveCount(0);
      await expect
        .poll(() =>
          editorState(first).then((state) =>
            state.elements.some((element: any) => element.id === original.id),
          ),
        )
        .toBe(false);
      await first.getByRole("button", { name: "忽略", exact: true }).click();
      // Guest permission loss preserves its rich draft and closes the editor.
      await second.getByTestId("toolbar-text").first().click();
      await second.mouse.click(950, 450);
      const guestInput = second.locator(".excalidraw-wysiwyg");

      await guestInput.pressSequentially("**guest draft**", { delay: 10 });
      await call(
        owner.context,
        baseURL!,
        owner.id,
        "links",
        { id: link.id },
        "DELETE",
      );
      await expect(guestInput).toHaveCount(0);
      await expect(
        second.getByText("文字编辑已结束，本地富文本副本已保留。"),
      ).toBeVisible();
      await expect(
        second.getByRole("button", { name: "恢复为新文字" }),
      ).toHaveCount(0);
      await second.reload();
      await expect(
        second.getByText("文字编辑已结束，本地富文本副本已保留。"),
      ).toBeVisible();
      await expect(second.locator(".excalidraw-wysiwyg")).toHaveCount(0);
      await expect(
        second.getByRole("button", { name: "恢复为新文字" }),
      ).toHaveCount(0);
      const beforeDownload = await call(
        owner.context,
        baseURL!,
        owner.id,
        "view",
      );
      const writes: string[] = [];

      second.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname.endsWith("/collaboration/update")
        )
          writes.push(request.url());
      });
      const pendingDownload = second.waitForEvent("download");

      await second
        .getByRole("button", { name: "下载文字副本", exact: true })
        .click();
      const downloaded = await pendingDownload;

      expect(downloaded.suggestedFilename()).toMatch(
        /文字恢复副本\.excalidraw$/,
      );
      const data = JSON.parse(
        await readFile((await downloaded.path())!, "utf8"),
      );

      expect(data.type).toBe("excalidraw");
      expect(data.elements).toHaveLength(1);
      expect(data.elements[0].originalText).toBe("guest draft");
      expect(data.elements[0].richText.doc.content[0].content[0]).toEqual({
        type: "text",
        text: "guest draft",
        marks: [{ type: "bold" }],
      });
      expect(data.elements[0].containerId).toBeNull();
      expect(data.files).toEqual({});
      expect(writes).toEqual([]);
      expect((await call(owner.context, baseURL!, owner.id, "view")).seq).toBe(
        beforeDownload.seq,
      );
      const protectedReads: string[] = [];

      second.on("request", (request) => {
        if (
          /\/collaboration\/(view|access)$/.test(
            new URL(request.url()).pathname,
          )
        )
          protectedReads.push(request.url());
      });
      // A hash-only navigation keeps the old component alive; reopen the URL in a fresh document.
      await second.goto("about:blank");
      await second.goto(link.path);
      await expect(second.getByText("暂时无法打开画布")).toBeVisible();
      await expect(
        second.getByText("文字编辑已结束，本地富文本副本已保留。"),
      ).toBeVisible();
      await expect(second.locator(".excalidraw")).toHaveCount(0);
      const localDownload = second.waitForEvent("download");

      await second
        .getByRole("button", { name: "下载文字副本", exact: true })
        .click();
      const localFile = await localDownload;
      const localData = JSON.parse(
        await readFile((await localFile.path())!, "utf8"),
      );

      expect(localData.elements[0].originalText).toBe("guest draft");
      expect(protectedReads).toEqual([]);
      expect(writes).toEqual([]);
    } finally {
      await guest.close();
    }
  } finally {
    await owner.context.close();
  }
});

for (const failure of ["QuotaExceededError", "SecurityError"]) {
  test(`富文本恢复写入 ${failure} 时明确提示刷新前下载，并保留最新内存副本与旧持久副本`, async ({
    browser,
    baseURL,
  }) => {
    const owner = await account(browser, baseURL!);
    const page = await owner.context.newPage();

    try {
      await open(page, `/c/${owner.id}`, true);
      await page.getByTestId("toolbar-text").first().click();
      await page.mouse.click(700, 350);
      const input = page.locator(".excalidraw-wysiwyg");

      await input.pressSequentially("**original**", { delay: 10 });
      await input.press("Escape");
      await expect
        .poll(async () =>
          (
            await call(owner.context, baseURL!, owner.id, "view")
          ).scene.elements.some((element: any) => element.richText),
        )
        .toBe(true);
      const view = await call(owner.context, baseURL!, owner.id, "view");
      const original = view.scene.elements.find(
        (element: any) => element.type === "text",
      );
      const recoveryKey = await page.evaluate(
        ({ userId, canvasId, original, failure }) => {
          const key = JSON.stringify([
            "excalidraw-rich-text-recovery",
            1,
            userId,
            canvasId,
            "",
            sessionStorage.getItem("excalidraw-draft-tab"),
          ]);
          const older = {
            ...original,
            text: "older persistent copy",
            originalText: "older persistent copy",
            richText: {
              version: 1,
              doc: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "older persistent copy" }],
                  },
                ],
              },
            },
          };

          localStorage.setItem(key, JSON.stringify(older));
          const setItem = Storage.prototype.setItem;

          Storage.prototype.setItem = function (candidate, value) {
            if (candidate === key)
              throw new DOMException("storage unavailable", failure);

            return setItem.call(this, candidate, value);
          };

          return key;
        },
        { userId: owner.user.id, canvasId: owner.id, original, failure },
      );

      await page.mouse.dblclick(705, 355);
      await input.press("End");
      await input.pressSequentially(" current local text");
      await call(owner.context, baseURL!, owner.id, "update", {
        protocolVersion: 1,
        textFormatVersion: 1,
        epoch: view.epoch,
        clientId: `storage-failure-${failure}`,
        clientSeq: 1,
        opId: crypto.randomUUID(),
        baseSeq: view.seq,
        elements: [
          {
            ...original,
            version: original.version + 100,
            versionNonce: 0,
            text: "remote winner",
            originalText: "remote winner",
            richText: {
              version: 1,
              doc: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "remote winner" }],
                  },
                ],
              },
            },
          },
        ],
      });
      await expect(input).toHaveCount(0);
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: "尚未写入浏览器，请刷新前下载" }),
      ).toBeVisible();
      await expect(
        page.getByText("文字编辑已结束，本地富文本副本已保留。", {
          exact: true,
        }),
      ).toHaveCount(0);
      expect(
        await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key)!).originalText,
          recoveryKey,
        ),
      ).toBe("older persistent copy");
      const pending = page.waitForEvent("download");

      await page
        .getByRole("button", { name: "下载文字副本", exact: true })
        .click();
      const file = await pending;
      const downloaded = JSON.parse(
        await readFile((await file.path())!, "utf8"),
      );

      expect(downloaded.elements[0].originalText).toContain(
        "current local text",
      );
      expect(downloaded.elements[0].originalText).not.toBe(
        "older persistent copy",
      );
      expect(downloaded.elements[0].richText.version).toBe(1);
    } finally {
      await owner.context.close();
    }
  });
}

test("回收站同页删除恢复重新打开，实时成员立即失去访问，旧epoch操作不能重放", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);
  const member = await account(browser, baseURL!);
  const page = await owner.context.newPage();
  const memberPage = await member.context.newPage();
  const headers = { Origin: baseURL!, "X-Requested-With": "excalidraw-demo" };

  try {
    await call(owner.context, baseURL!, owner.id, "members", {
      email: member.email,
      role: "editor",
      viewMode: "live",
    });
    await open(page, "/", true);
    await open(memberPage, `/c/${owner.id}`, true);
    await draw(page, 700);
    await expect
      .poll(
        async () =>
          (await call(owner.context, baseURL!, owner.id, "view")).scene.elements
            .length,
      )
      .toBe(1);
    const before = await call(owner.context, baseURL!, owner.id, "view");

    await page.getByLabel("画布 未命名画布 的操作", { exact: true }).click();
    await page
      .getByRole("button", { name: "删除画布 未命名画布", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "移入回收站", exact: true })
      .getByRole("button", { name: "移入回收站", exact: true })
      .click();
    await expect(page.locator(".canvas-name")).toHaveCount(0);
    await expect
      .poll(() =>
        editorState(memberPage).then((state) => state.viewModeEnabled),
      )
      .toBe(true);
    const denied = await member.context.request.get(
      `/api/canvases/${owner.id}/collaboration/view`,
    );

    expect(denied.status()).toBe(410);
    await page.getByRole("button", { name: "回收站", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "回收站", exact: true });

    await panel
      .getByRole("button", { name: "恢复 未命名画布", exact: true })
      .click();
    await expect(panel.getByText("回收站是空的")).toBeVisible();
    await panel
      .getByRole("button", { name: "关闭回收站", exact: true })
      .click();
    await page.locator(".canvas-name").click();
    await expect(page.locator(".excalidraw")).toBeVisible();
    await expect
      .poll(() => editorState(page).then((state) => state.viewModeEnabled))
      .toBe(false);
    const after = await call(owner.context, baseURL!, owner.id, "view");

    expect(after.epoch).not.toBe(before.epoch);
    expect(after.scene.elements.map((element: any) => element.id)).toEqual(
      before.scene.elements.map((element: any) => element.id),
    );
    const stale = await member.context.request.post(
      `/api/canvases/${owner.id}/collaboration/update`,
      {
        headers,
        data: {
          protocolVersion: 1,
          epoch: before.epoch,
          baseSeq: before.seq,
          clientId: "recycle-stale-client",
          clientSeq: 1,
          opId: "recycle-stale-operation",
          elements: [],
        },
      },
    );

    expect(stale.status()).toBe(409);
    await memberPage.reload();
    await expect
      .poll(() =>
        editorState(memberPage).then((state) => state.viewModeEnabled),
      )
      .toBe(false);
    await draw(memberPage, 600);
    await expect
      .poll(
        async () =>
          (await call(owner.context, baseURL!, owner.id, "view")).scene.elements
            .length,
      )
      .toBe(2);
  } finally {
    await owner.context.close();
    await member.context.close();
  }
});

test("回收工作空间保留曾单独回收的画布，并可同页恢复父空间", async ({
  browser,
  baseURL,
}) => {
  const owner = await account(browser, baseURL!);
  const page = await owner.context.newPage();
  const headers = { Origin: baseURL!, "X-Requested-With": "excalidraw-demo" };

  try {
    const spaces = (
      await (await owner.context.request.get("/api/workspaces")).json()
    ).workspaces;
    const workspace = spaces[0];
    const second = await owner.context.request.post(
      `/api/workspaces/${workspace.id}/canvases`,
      { headers, data: { name: "保留画布", catalogRevision: 0 } },
    );

    expect(second.status()).toBe(200);
    await open(page, "/", true);
    await page.getByLabel("画布 未命名画布 的操作", { exact: true }).click();
    await page
      .getByRole("button", { name: "删除画布 未命名画布", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "移入回收站", exact: true })
      .getByRole("button", { name: "移入回收站", exact: true })
      .click();
    await expect(page.locator(".canvas-name")).toHaveCount(1);
    await page.getByLabel("工作空间操作", { exact: true }).click();
    await page
      .getByRole("button", { name: "删除工作空间", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "移入回收站", exact: true })
      .getByRole("button", { name: "移入回收站", exact: true })
      .click();
    await expect(page.locator(".canvas-name")).toHaveCount(0);
    await page.getByRole("button", { name: "回收站", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "回收站", exact: true });

    await panel
      .getByRole("button", { name: `恢复 ${workspace.name}`, exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: "恢复 未命名画布", exact: true }),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: "关闭回收站", exact: true })
      .click();
    await expect(page.locator(".canvas-name")).toHaveCount(1);
    await expect(page.locator(".canvas-name")).toHaveText("保留画布");
    await expect(page.locator(".excalidraw")).toBeVisible();
  } finally {
    await owner.context.close();
  }
});
