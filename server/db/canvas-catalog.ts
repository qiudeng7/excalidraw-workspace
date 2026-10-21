import { db } from "@nuxthub/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  or,
} from "drizzle-orm";
import * as tables from "#server/db/schema";
import { ownedWorkspaceIds } from "#server/db/workspaces";
import { ApiError, fail, isObject } from "#server/utils/http";

interface CatalogCursor {
  version: 1;
  workspace: string;
  revision: number;
  pinned: boolean;
  position: number;
  id: string;
}

const { objectKey: _object, ...metadata } = getTableColumns(tables.canvases);
const ownedCatalog = (workspace: string, user: string) =>
  and(
    eq(tables.workspaces.id, workspace),
    eq(tables.workspaces.userId, user),
    eq(tables.workspaces.deleting, 0),
    isNull(tables.workspaces.deletedAt),
  );
const visibleCanvases = (workspace: string, user: string) =>
  and(
    eq(tables.canvases.workspaceId, workspace),
    isNull(tables.canvases.deletedAt),
    inArray(tables.canvases.workspaceId, ownedWorkspaceIds(user)),
  );

const decodeCursor = (value: string, workspace: string): CatalogCursor => {
  let cursor: unknown;

  try {
    if (value.length > 2048 || !/^[\w-]+$/.test(value)) {
      throw new Error("Invalid cursor encoding");
    }

    cursor = JSON.parse(
      decodeURIComponent(atob(value.replace(/-/g, "+").replace(/_/g, "/"))),
    );
  } catch (error) {
    throw new ApiError(400, "INVALID_CURSOR", "分页游标无效", { cause: error });
  }

  if (
    !isObject(cursor) ||
    cursor.version !== 1 ||
    cursor.workspace !== workspace ||
    typeof cursor.revision !== "number" ||
    !Number.isSafeInteger(cursor.revision) ||
    cursor.revision < 0 ||
    typeof cursor.pinned !== "boolean" ||
    typeof cursor.position !== "number" ||
    !Number.isSafeInteger(cursor.position) ||
    typeof cursor.id !== "string" ||
    !cursor.id
  ) {
    return fail(400, "INVALID_CURSOR", "分页游标无效");
  }

  return {
    version: 1,
    workspace,
    revision: cursor.revision,
    pinned: cursor.pinned,
    position: cursor.position,
    id: cursor.id,
  };
};

const encodeCursor = (cursor: CatalogCursor) =>
  btoa(encodeURIComponent(JSON.stringify(cursor)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const catalogPageRequest = (parameters: URLSearchParams) => {
  if (!parameters.has("limit") && !parameters.has("cursor")) {
    return undefined;
  }

  const value = parameters.get("limit");
  const limit = value === null ? 30 : Number(value);

  if (
    parameters.getAll("limit").length > 1 ||
    parameters.getAll("cursor").length > 1 ||
    (value !== null && !/^\d+$/.test(value)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return fail(400, "INVALID_PAGINATION", "每页数量需为 1–100 的整数");
  }

  return { limit, cursor: parameters.get("cursor") ?? undefined };
};

const afterCursor = (cursor: CatalogCursor) =>
  or(
    cursor.pinned ? eq(tables.canvases.pinned, false) : undefined,
    and(
      eq(tables.canvases.pinned, cursor.pinned),
      or(
        gt(tables.canvases.position, cursor.position),
        and(
          eq(tables.canvases.position, cursor.position),
          gt(tables.canvases.id, cursor.id),
        ),
      ),
    ),
  );

/** Native batches give the revision, count and bounded range one database snapshot. */
export const canvasCatalogPage = async (
  workspace: string,
  user: string,
  limit: number,
  value?: string,
) => {
  const cursor =
    value === undefined ? undefined : decodeCursor(value, workspace);
  const [revisions, totals, rows] = await db.batch([
    db
      .select({ catalogRevision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(ownedCatalog(workspace, user)),
    db
      .select({ total: count() })
      .from(tables.canvases)
      .where(visibleCanvases(workspace, user)),
    db
      .select(metadata)
      .from(tables.canvases)
      .where(
        and(
          visibleCanvases(workspace, user),
          cursor ? afterCursor(cursor) : undefined,
        ),
      )
      .orderBy(
        desc(tables.canvases.pinned),
        asc(tables.canvases.position),
        asc(tables.canvases.id),
      )
      .limit(limit + 1),
  ]);
  const catalogRevision = revisions[0]?.catalogRevision;

  if (catalogRevision === undefined) {
    return fail(404, "NOT_FOUND", "工作区不存在");
  }

  if (cursor && cursor.revision !== catalogRevision) {
    return fail(409, "CATALOG_CONFLICT", "列表已在其他页面更新，请重新加载");
  }

  const canvases = rows.slice(0, limit);
  const last = canvases.at(-1);

  return {
    canvases,
    catalogRevision,
    total: totals[0]!.total,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({
            version: 1,
            workspace,
            revision: catalogRevision,
            pinned: last.pinned,
            position: last.position,
            id: last.id,
          })
        : null,
  };
};

/** Read only one canvas after a pin; legacy callers can still request the full catalog. */
export const canvasPinSummary = async (
  workspace: string,
  user: string,
  id: string,
) => {
  const [revisions, canvases] = await db.batch([
    db
      .select({ catalogRevision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(ownedCatalog(workspace, user)),
    db
      .select(metadata)
      .from(tables.canvases)
      .where(and(visibleCanvases(workspace, user), eq(tables.canvases.id, id)))
      .limit(1),
  ]);

  if (!revisions[0] || !canvases[0]) {
    return fail(404, "NOT_FOUND", "画布不存在");
  }

  return { canvas: canvases[0], catalogRevision: revisions[0].catalogRevision };
};
