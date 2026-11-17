// 工作空间搜索浏览器套件的 HTTP 替身：真实界面与真实编辑器，搜索、目标画布与最近位置由本文件响应。
// 只覆盖浏览器入口与定位表现；权限、分页校验与房间读取的断言留在 integration 套件。
import type { Page } from "@playwright/test";
import type { CanvasDocument } from "../../shared/contracts";
import type { SearchPage } from "../../shared/workspace-search";

export interface SearchRequestLog {
  query: string;
  cursor: string | null;
  currentCanvasId: string | null;
}

export interface WorkspaceSearchMockOptions {
  /** 依次返回的页；超出后重复最后一页。 */
  pages: SearchPage[];
  fail?: { status: number; code: string; message: string };
  /** 当前画布文档；需要页面重新加载后才生效。 */
  current?: CanvasDocument;
  /** 结果里要打开的另一个画布文档。 */
  target?: CanvasDocument;
}

export const installWorkspaceSearchMock = async (
  page: Page,
  options: WorkspaceSearchMockOptions,
) => {
  const requests: SearchRequestLog[] = [];
  let index = 0;
  let revision = 0;

  await page.route("**/api/workspaces/test-space/search*", async (route) => {
    const query = new URL(route.request().url()).searchParams;

    requests.push({
      query: query.get("q") ?? "",
      cursor: query.get("cursor"),
      currentCanvasId: query.get("currentCanvasId"),
    });
    if (options.fail)
      return route.fulfill({
        status: options.fail.status,
        json: {
          error: { code: options.fail.code, message: options.fail.message },
        },
      });
    const body = options.pages[Math.min(index, options.pages.length - 1)] ?? {
      groups: [],
      nextCursor: null,
      catalogRevision: 0,
      skipped: [],
    };

    index++;

    return route.fulfill({ json: body });
  });
  for (const document of [options.current, options.target].filter(Boolean))
    await page.route(`**/api/canvases/${document!.id}`, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();

      return route.fulfill({ json: { canvas: document } });
    });
  await page.route("**/api/navigation", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    revision++;
    const id = (route.request().postDataJSON() as { canvasId?: string })
      .canvasId;

    return route.fulfill({
      json: {
        revision,
        lastWorkspaceId: "test-space",
        lastCanvasId: id ?? null,
        workspaces: [{ workspaceId: "test-space", lastCanvasId: id ?? null }],
      },
    });
  });

  return { requests };
};
