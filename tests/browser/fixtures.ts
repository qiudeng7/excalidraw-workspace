import {
  test as base,
  expect,
  type Page,
  type Locator,
} from "@playwright/test";
import { createDefaultUserSettings } from "../../shared/contracts";
import type { User } from "../../shared/contracts";
import { currentRelease } from "../../src/data/releases";
import { announcementKey } from "../../src/lib/releaseProgress";

type Mode = "ok" | "unavailable" | "error" | "conflict";

export const categories = [
  "通用",
  "账号",
  "系统设置",
  "调试",
  "编辑器",
  "更新日志",
];

export async function editorState(page: Page) {
  // Read the real editor instance without adding a test hook to product code.
  const read = () =>
    page.locator(".excalidraw").evaluate((element) => {
      const node = element as any;

      let fiber =
        node[Object.keys(node).find((key) => key.startsWith("__reactFiber$"))!];

      while (fiber) {
        if (fiber.stateNode?.state?.activeTool) {
          const app = fiber.stateNode;

          return {
            activeTool: app.state.activeTool,
            selectedElementIds: app.state.selectedElementIds,
            selectedGroupIds: app.state.selectedGroupIds,
            viewModeEnabled: app.state.viewModeEnabled,
            editingTextElement: app.state.editingTextElement?.id ?? null,
            scrollX: app.state.scrollX,
            scrollY: app.state.scrollY,
            zoom: app.state.zoom,
            elements: app.api.getSceneElements(),
          };
        }

        fiber = fiber.return;
      }

      return null;
    });
  let state = await read();

  if (!state)
    await expect
      .poll(
        async () => {
          state = await read();

          return !!state;
        },
        { message: "React editor instance must finish mounting" },
      )
      .toBe(true);

  return state!;
}

export interface WorkspaceFixture {
  dialog: Locator;
  mock: {
    user: User;
    settings: ReturnType<typeof createDefaultUserSettings>;
    revision: number;
    mode: Mode;
  };
  open: () => Promise<void>;
  close: () => Promise<void>;
  setBottomToolbar: (bottom: boolean) => Promise<void>;
}

export const test = base.extend<{
  workspace: WorkspaceFixture;
  accountRole: "admin" | "user";
  announcementSeen: boolean;
}>({
  accountRole: ["admin", { option: true }],
  announcementSeen: [true, { option: true }],
  workspace: async ({ page, context, accountRole, announcementSeen }, use) => {
    const errors: string[] = [];
    const user = {
      id: "test-user",
      email: "browser@example.test",
      name: "测试用户",
      role: accountRole,
    };

    if (announcementSeen)
      await context.addInitScript(
        ({ key, id }) => localStorage.setItem(key, id),
        {
          key: announcementKey(user.id, currentRelease.sequence),
          id: currentRelease.id,
        },
      );
    const workspace = {
      id: "test-space",
      name: "测试空间",
      createdAt: "2026-10-12",
      updatedAt: "2026-10-12",
      catalogRevision: 0,
    };
    const canvas = {
      id: "test-canvas",
      workspaceId: workspace.id,
      name: "测试画布",
      createdAt: "2026-10-12",
      updatedAt: "2026-10-12",
      revision: 0,
      position: 0,
      scene: { elements: [], appState: {}, files: {} },
    };
    const mock: WorkspaceFixture["mock"] = {
      user,
      settings: createDefaultUserSettings(),
      revision: 0,
      mode: "ok",
    };

    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.text().includes("[NUXT_E1005]")) errors.push(message.text());
    });
    page.on("response", (response) => {
      if (
        response.request().resourceType() === "script" &&
        response.status() >= 400
      ) {
        errors.push(`Script HTTP ${response.status()}: ${response.url()}`);
      }
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;

      if (!(path === "/api" || path.startsWith("/api/")))
        return route.continue();
      const key = `${request.method()} ${path}`;
      let data: unknown;
      const fail = (status: number, code: string, message: string) =>
        route.fulfill({ status, json: { error: { code, message } } });

      switch (key) {
        case "GET /api/bootstrap":
          data = {
            needsSetup: false,
            registrationEnabled: true,
            emailVerification: false,
          };
          break;
        case "GET /api/session":
          data = { user };
          break;
        case "GET /api/user-settings":
          if (mock.mode === "unavailable")
            return fail(503, "TEST_UNAVAILABLE", "模拟云端读取失败");
          data = {
            settings: mock.settings,
            revision: mock.revision,
            configured: true,
          };
          break;
        case "PUT /api/user-settings":
          if (mock.mode === "error")
            return fail(503, "TEST_FAILURE", "模拟同步失败");
          if (mock.mode === "conflict") {
            mock.mode = "ok";
            mock.revision++;

            return fail(409, "USER_SETTINGS_CONFLICT", "模拟设置冲突");
          }

          mock.settings = request.postDataJSON().settings;
          mock.revision++;
          data = {
            settings: mock.settings,
            revision: mock.revision,
            configured: true,
          };
          break;
        case "GET /api/workspaces":
          data = { workspaces: [workspace] };
          break;
        case "GET /api/workspaces/test-space/canvases":
          data = { canvases: [canvas], catalogRevision: 0 };
          break;
        case "GET /api/canvases/test-canvas":
          data = { canvas };
          break;
        case "PUT /api/canvases/test-canvas":
          data = { revision: ++canvas.revision, updatedAt: canvas.updatedAt };
          break;
        case "GET /api/library":
          data = { items: [], revision: 0 };
          break;
        case "GET /api/navigation":
          data = {
            revision: 0,
            lastWorkspaceId: workspace.id,
            lastCanvasId: canvas.id,
            workspaces: [
              { workspaceId: workspace.id, lastCanvasId: canvas.id },
            ],
          };
          break;
        default:
          errors.push(`Unexpected API: ${key}`);
          await route.abort("blockedbyclient");

          return;
      }

      await route.fulfill({ json: data });
    });
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    const open = async () => {
      await expect(page.locator(".excalidraw")).toBeVisible();
      const entry = page.getByRole("button", { name: "设置", exact: true });

      if (!(await entry.isVisible()))
        await page
          .getByRole("button", { name: "切换工作空间侧边栏", exact: true })
          .click();
      await entry.click();
      await expect(dialog).toBeVisible();
    };
    const close = async () => {
      await dialog.getByRole("button", { name: "关闭设置" }).click();
      await expect(dialog).toBeHidden();
    };
    const setBottomToolbar = async (bottom: boolean) => {
      await dialog.getByRole("tab", { name: "编辑器", exact: true }).click();
      const checkbox = dialog.getByRole("checkbox", {
        name: "工具栏置底",
        exact: true,
      });

      if ((await checkbox.isChecked()) !== bottom)
        await checkbox.locator("..").click();
      await expect(checkbox).toBeChecked({ checked: bottom });
    };

    await page.goto("/");
    await expect(page.locator(".excalidraw")).toBeVisible();
    await expect
      .poll(() => editorState(page).then((state) => state.elements.length))
      .toBe(0);
    await use({ dialog, mock, open, close, setBottomToolbar });
    await expect(
      page.locator("[data-nuxt-dev-error], nuxt-error-overlay"),
      "Nuxt must not retain a caught runtime error overlay",
    ).toHaveCount(0);
    expect(
      errors,
      "page/initialization errors, failed scripts and unexpected API requests",
    ).toEqual([]);
  },
});

export { expect };
