// 使用真实 H3 路由与临时 SQLite；SQL 只建立隔离数据，业务操作均走公开 HTTP。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeStorage } from "./storage";
import { handleApi } from "./api";
import { canvases } from "#server/db/schema";
import type { CanvasCatalog, CanvasCatalogPage } from "#shared/contracts";

export const catalogFixture = async (count = 65) => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-pagination-"));
  const storage = await nodeStorage(directory, undefined, true);
  const pending: Promise<unknown>[] = [];
  const request = async (
    path: string,
    method = "GET",
    data?: unknown,
    cookie = ownerCookie,
  ) => {
    const response = await handleApi(
      new Request(`https://catalog.test/api${path}`, {
        method,
        headers: {
          Origin: "https://catalog.test",
          "X-Requested-With": "excalidraw-demo",
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      {
        ...storage,
        publicOrigin: "https://catalog.test",
        waitUntil: (task) => pending.push(task),
      },
    );

    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    };
  };
  let ownerCookie = "";
  const account = await request("/setup", "POST", {
    email: "catalog-owner@example.test",
    password: "CatalogPassword123!",
  });

  assert.equal(account.status, 200);
  ownerCookie = account.cookie;
  const spaces = await request("/workspaces");
  const workspaceId = spaces.body.workspaces[0].id as string;
  // 保留初始化画布，额外记录包含重复 position，证明 ID 为稳定的排序末键。
  const now = new Date().toISOString();

  if (count > 1) {
    await storage.database.insert(canvases).values(
      Array.from({ length: count - 1 }, (_, i) => ({
        id: `page-${String(i).padStart(4, "0")}`,
        workspaceId,
        name: `画布 ${i}`,
        createdAt: now,
        updatedAt: now,
        position: Math.floor(i / 2) + 1,
        pinned: i % 7 === 0,
      })),
    );
  }

  const catalog = async (space = workspaceId): Promise<CanvasCatalog> => {
    const result = await request(`/workspaces/${space}/canvases`);

    assert.equal(result.status, 200);

    return result.body;
  };
  const page = async (
    limit = 30,
    cursor?: string,
    space = workspaceId,
  ): Promise<CanvasCatalogPage> => {
    const query = new URLSearchParams({ limit: String(limit) });

    if (cursor) query.set("cursor", cursor);
    const result = await request(`/workspaces/${space}/canvases?${query}`);

    assert.equal(result.status, 200);

    return result.body;
  };

  return {
    request,
    catalog,
    page,
    storage,
    directory,
    workspaceId,
    ownerCookie,
    async close() {
      await Promise.all(pending);
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};
