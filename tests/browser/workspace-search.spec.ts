// 真实 Chromium 验证工作空间搜索的两个入口（侧栏输入与 Ctrl/Cmd+P）、组合输入、标题打开与元素定位。
// 搜索与目标画布使用 workspace-search-mock 替身；除当前画布本地覆盖外不证明云端搜索语义。
import type { Page } from "@playwright/test";
import type { CanvasDocument } from "../../shared/contracts";
import type { SearchPage } from "../../shared/workspace-search";
import { test, expect, editorState } from "./fixtures";
import { installWorkspaceSearchMock } from "./workspace-search-mock";

const emptyPage: SearchPage = {
  groups: [],
  nextCursor: null,
  catalogRevision: 0,
  skipped: [],
};

const canvasDoc = (
  id: string,
  name: string,
  elements: unknown[] = [],
): CanvasDocument => ({
  id,
  workspaceId: "test-space",
  name,
  revision: 0,
  position: 0,
  pinned: false,
  syncMode: "legacy",
  roomEpoch: null,
  createdAt: "2026-10-22",
  updatedAt: "2026-10-22",
  scene: { elements, appState: {}, files: {} },
});

const textElement = (id: string, value: string) => ({
  id,
  type: "text",
  x: 40,
  y: 40,
  width: 120,
  height: 25,
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
  text: value,
  originalText: value,
  fontSize: 20,
  fontFamily: 1,
  textAlign: "left",
  verticalAlign: "top",
  containerId: null,
  lineHeight: 1.25,
  autoResize: true,
});

const shortcut = process.platform === "darwin" ? "Meta+p" : "Control+p";
const entry = (page: Page) => page.getByTestId("workspace-search-entry");
const panel = (page: Page) => page.getByTestId("workspace-search-panel");
const input = (page: Page) => page.getByTestId("workspace-search-input");
const option = (page: Page) => page.getByTestId("workspace-search-option");
const highlight = (page: Page) => page.getByTestId("search-target-highlight");

const showSidebar = async (page: Page) => {
  const toggle = page.getByRole("button", {
    name: "切换工作空间侧边栏",
    exact: true,
  });

  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await expect(entry(page)).toBeVisible();
};

test("侧栏输入与快捷键打开同一弹窗，组合输入期间不响应按键，Esc 归还焦点", async ({
  page,
}) => {
  await installWorkspaceSearchMock(page, { pages: [emptyPage] });
  await showSidebar(page);
  await entry(page).fill("补贴");
  await expect(panel(page)).toBeVisible();
  await expect(input(page)).toHaveValue("补贴");
  await input(page).press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(entry(page)).toBeFocused();
  await page.keyboard.press(shortcut);
  await expect(panel(page)).toBeVisible();
  await expect(input(page)).toBeFocused();

  // 中文组合输入期间 Enter/Escape/方向键不触发操作，composition 结束后才恢复。
  await input(page).fill("补贴");
  await input(page).dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await input(page).dispatchEvent("keydown", { key: "Escape", isComposing: true });
  await expect(panel(page)).toBeVisible();
  await input(page).dispatchEvent("compositionend", { data: "补贴" });
  await input(page).press("Escape");
  await expect(panel(page)).toBeHidden();
});

test("结果按画布分组并自动串行翻页，标题结果用现有导航正常打开", async ({
  page,
}) => {
  const target = canvasDoc("canvas-2", "第二画布");
  const mock = await installWorkspaceSearchMock(page, {
    pages: [
      {
        groups: [
          {
            canvas: { id: "canvas-2", name: "第二画布", workspaceId: "test-space" },
            titleMatched: true,
            matches: [],
          },
        ],
        nextCursor: "cursor-2",
        catalogRevision: 0,
        skipped: [],
      },
      { ...emptyPage, catalogRevision: 0 },
    ],
    target,
  });

  await showSidebar(page);
  await entry(page).fill("第二画布");
  await expect(option(page)).toHaveCount(1);
  // 有 nextCursor 时自动串行下一页，不需要用户操作。
  await expect.poll(() => mock.requests.length).toBe(2);
  await expect.poll(() => mock.requests[1]!.cursor).toBe("cursor-2");
  await option(page).click();
  await expect(panel(page)).toBeHidden();
  await expect(
    page.getByRole("tab", { name: "第二画布", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(highlight(page)).toHaveCount(0);
});

test("元素结果打开当前画布后定位并高亮2秒，用本地最新正文覆盖云端旧命中", async ({
  page,
}) => {
  const current = canvasDoc("test-canvas", "测试画布", [
    textElement("local-1", "本地最新文字"),
  ]);
  const mock = await installWorkspaceSearchMock(page, {
    pages: [
      {
        groups: [
          {
            canvas: { id: "test-canvas", name: "测试画布", workspaceId: "test-space" },
            titleMatched: false,
            matches: [
              {
                kind: "text",
                elementId: "server-stale",
                snippet: "旧的服务端文字",
                matchStart: 0,
                matchEnd: 1,
              },
            ],
          },
        ],
        nextCursor: null,
        catalogRevision: 0,
        validatedCurrentCanvasId: "test-canvas",
        skipped: [],
      },
    ],
    current,
  });

  await page.reload();
  await expect(page.locator(".excalidraw")).toBeVisible();
  await showSidebar(page);
  await entry(page).fill("本地");
  await expect(option(page)).toHaveCount(1);
  // 当前画布由本地场景整组替换，云端旧命中不再显示。
  await expect(option(page)).toHaveAttribute("data-element-id", "local-1");
  expect(mock.requests[0]!.currentCanvasId).toBe("test-canvas");
  await option(page).click();
  await expect(panel(page)).toBeHidden();
  await expect(highlight(page)).toBeVisible();
  // 定位不劫持用户选择。
  expect((await editorState(page)).selectedElementIds).toEqual({});
  await expect(highlight(page)).toBeHidden({ timeout: 4000 });
});
