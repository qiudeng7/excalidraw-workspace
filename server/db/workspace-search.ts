import { db } from "@nuxthub/db";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import * as tables from "#server/db/schema";
import { ApiError, fail, isObject } from "#server/utils/http";
import type { SearchCanvasRef } from "#shared/workspace-search";

export const WORKSPACE_SEARCH_PAGE_SIZE = 10;

interface SearchCursor {
  version: 1;
  workspaceId: string;
  catalogRevision: number;
  lastCanvasId: string;
}

export interface WorkspaceSearchCandidate extends SearchCanvasRef {
  parentId: string | null;
}

export interface WorkspaceSearchBatch {
  candidates: WorkspaceSearchCandidate[];
  catalogRevision: number;
  nextCursor: string | null;
  validatedCurrentCanvasId?: string;
}

const encodeCursor = (cursor: SearchCursor) =>
  btoa(encodeURIComponent(JSON.stringify(cursor)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const decodeCursor = (value: string, workspaceId: string): SearchCursor => {
  let cursor: unknown;

  try {
    if (value.length > 2048 || !/^[\w-]+$/.test(value))
      throw new Error("Invalid cursor encoding");
    cursor = JSON.parse(
      decodeURIComponent(atob(value.replace(/-/g, "+").replace(/_/g, "/"))),
    );
  } catch (cause) {
    throw new ApiError(400, "INVALID_CURSOR", "搜索游标无效", { cause });
  }

  if (
    !isObject(cursor) ||
    cursor.version !== 1 ||
    cursor.workspaceId !== workspaceId ||
    typeof cursor.catalogRevision !== "number" ||
    !Number.isSafeInteger(cursor.catalogRevision) ||
    cursor.catalogRevision < 0 ||
    typeof cursor.lastCanvasId !== "string" ||
    !cursor.lastCanvasId
  )
    return fail(400, "INVALID_CURSOR", "搜索游标无效");

  return {
    version: 1,
    workspaceId,
    catalogRevision: cursor.catalogRevision,
    lastCanvasId: cursor.lastCanvasId,
  };
};

const ownedWorkspace = (workspaceId: string, userId: string) =>
  and(
    eq(tables.workspaces.id, workspaceId),
    eq(tables.workspaces.userId, userId),
    eq(tables.workspaces.deleting, 0),
    isNull(tables.workspaces.deletedAt),
  );

const buildFolderPaths = (
  candidates: Pick<WorkspaceSearchCandidate, "id" | "parentId">[],
  folders: { id: string; parentId: string | null; name: string }[],
) => {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));

  return new Map(
    candidates.map((candidate) => {
      const names: string[] = [];
      const visited = new Set<string>();
      let parentId = candidate.parentId;

      while (parentId) {
        if (visited.has(parentId)) break;
        visited.add(parentId);
        const folder = byId.get(parentId);

        if (!folder) break;
        names.push(folder.name);
        parentId = folder.parentId;
      }

      return [candidate.id, names.reverse().join(" / ")];
    }),
  );
};

export const workspaceSearchBatch = async (
  workspaceId: string,
  userId: string,
  options: { cursor?: string; currentCanvasId?: string },
): Promise<WorkspaceSearchBatch> => {
  const cursor =
    options.cursor === undefined
      ? undefined
      : decodeCursor(options.cursor, workspaceId);
  const [workspaceRows, rows, folders, currentRows] = await Promise.all([
    db
      .select({ catalogRevision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(ownedWorkspace(workspaceId, userId))
      .limit(1),
    db
      .select({
        id: tables.canvases.id,
        workspaceId: tables.canvases.workspaceId,
        parentId: tables.canvases.parentId,
        name: tables.canvases.name,
      })
      .from(tables.canvases)
      .innerJoin(
        tables.workspaces,
        eq(tables.workspaces.id, tables.canvases.workspaceId),
      )
      .where(
        and(
          eq(tables.canvases.workspaceId, workspaceId),
          eq(tables.workspaces.userId, userId),
          eq(tables.workspaces.deleting, 0),
          isNull(tables.workspaces.deletedAt),
          isNull(tables.canvases.deletedAt),
          cursor ? gt(tables.canvases.id, cursor.lastCanvasId) : undefined,
        ),
      )
      .orderBy(asc(tables.canvases.id))
      .limit(WORKSPACE_SEARCH_PAGE_SIZE + 1),
    db
      .select({
        id: tables.folders.id,
        parentId: tables.folders.parentId,
        name: tables.folders.name,
      })
      .from(tables.folders)
      .where(
        and(
          eq(tables.folders.workspaceId, workspaceId),
          isNull(tables.folders.deletedAt),
        ),
      ),
    options.currentCanvasId
      ? db
          .select({ id: tables.canvases.id })
          .from(tables.canvases)
          .innerJoin(
            tables.workspaces,
            eq(tables.workspaces.id, tables.canvases.workspaceId),
          )
          .where(
            and(
              eq(tables.canvases.id, options.currentCanvasId),
              eq(tables.canvases.workspaceId, workspaceId),
              eq(tables.workspaces.userId, userId),
              eq(tables.workspaces.deleting, 0),
              isNull(tables.workspaces.deletedAt),
              isNull(tables.canvases.deletedAt),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
  ]);
  const catalogRevision = workspaceRows[0]?.catalogRevision;

  if (catalogRevision === undefined)
    return fail(404, "NOT_FOUND", "工作区不存在");
  if (cursor && cursor.catalogRevision !== catalogRevision)
    return fail(409, "SEARCH_CATALOG_CHANGED", "工作区目录已变化，请重新搜索");

  const candidates = rows.slice(0, WORKSPACE_SEARCH_PAGE_SIZE);
  const paths = buildFolderPaths(candidates, folders);
  const last = candidates.at(-1);

  return {
    candidates: candidates.map((candidate) => ({
      ...candidate,
      folderPath: paths.get(candidate.id) ?? "",
    })),
    catalogRevision,
    nextCursor:
      rows.length > WORKSPACE_SEARCH_PAGE_SIZE && last
        ? encodeCursor({
            version: 1,
            workspaceId,
            catalogRevision,
            lastCanvasId: last.id,
          })
        : null,
    ...(currentRows[0] ? { validatedCurrentCanvasId: currentRows[0].id } : {}),
  };
};

export const confirmWorkspaceSearchRevision = async (
  workspaceId: string,
  userId: string,
  expectedRevision: number,
) => {
  const row = (
    await db
      .select({ catalogRevision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(ownedWorkspace(workspaceId, userId))
      .limit(1)
  )[0];

  if (!row) return fail(404, "NOT_FOUND", "工作区不存在");
  if (row.catalogRevision !== expectedRevision)
    return fail(409, "SEARCH_CATALOG_CHANGED", "工作区目录已变化，请重新搜索");
};
