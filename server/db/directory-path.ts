import { and, desc, eq, isNull, or, lt } from "drizzle-orm";
import { db } from "@nuxthub/db";
import * as tables from "#server/db/schema";
import type {
  DirectoryNode,
  DirectoryPage,
  DirectoryPath,
  NodeRef,
} from "#shared/directory-contracts";
import { directoryItem, directoryPage } from "#server/db/directory";
import { ApiError, fail } from "#server/utils/http";

const byOrder = (a: DirectoryNode, b: DirectoryNode) =>
  a.position - b.position ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
  (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);

async function previousSibling(
  workspaceId: string,
  node: DirectoryNode,
): Promise<DirectoryNode | null> {
  const preceding = (
    table: typeof tables.folders | typeof tables.canvases,
    kind: "folder" | "canvas",
  ) =>
    and(
      eq(table.workspaceId, workspaceId),
      node.parentId === null
        ? isNull(table.parentId)
        : eq(table.parentId, node.parentId),
      isNull(table.deletedAt),
      or(
        lt(table.position, node.position),
        and(eq(table.position, node.position), lt(table.id, node.id)),
        kind === "canvas" && node.kind === "folder"
          ? and(eq(table.position, node.position), eq(table.id, node.id))
          : undefined,
      ),
    );
  const folderRows = await db
    .select()
    .from(tables.folders)
    .where(preceding(tables.folders, "folder"))
    .orderBy(desc(tables.folders.position), desc(tables.folders.id))
    .limit(1);
  const canvasRows = await db
    .select()
    .from(tables.canvases)
    .where(preceding(tables.canvases, "canvas"))
    .orderBy(desc(tables.canvases.position), desc(tables.canvases.id))
    .limit(1);
  const candidates: DirectoryNode[] = [
    ...folderRows.map((row): DirectoryNode => ({
      kind: "folder",
      id: row.id,
      workspaceId: row.workspaceId,
      parentId: row.parentId,
      name: row.name,
      position: row.position,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      favorite: false,
      depth: 1,
      childCount: 0,
      subtreeDepth: 1,
    })),
    ...canvasRows.map((row): DirectoryNode => ({
      kind: "canvas",
      id: row.id,
      workspaceId: row.workspaceId,
      parentId: row.parentId,
      name: row.name,
      position: row.position,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      favorite: false,
      canvas: {
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        revision: row.revision,
        syncMode: row.syncMode,
        roomEpoch: row.roomEpoch,
        migrationEpoch: row.migrationEpoch,
        position: row.position,
        pinned: row.pinned,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    })),
  ];

  return candidates.sort(byOrder).at(-1) ?? null;
}

const cursorAfter = (
  workspaceId: string,
  parentId: string | null,
  revision: number,
  item: DirectoryNode,
) =>
  btoa(
    encodeURIComponent(
      JSON.stringify({
        version: 1,
        workspaceId,
        parentId,
        catalogRevision: revision,
        position: item.position,
        id: item.id,
        kind: item.kind,
      }),
    ),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function directoryPath(
  workspaceId: string,
  userId: string,
  target: NodeRef,
): Promise<DirectoryPath> {
  const item = await directoryItem(workspaceId, userId, target);

  if (!item) return fail(404, "NOT_FOUND", "目录项目不存在");
  const revision = (
    await db
      .select({ revision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(
        and(
          eq(tables.workspaces.id, workspaceId),
          eq(tables.workspaces.userId, userId),
          eq(tables.workspaces.deleting, 0),
          isNull(tables.workspaces.deletedAt),
        ),
      )
      .limit(1)
  )[0]?.revision;

  if (revision === undefined) return fail(404, "NOT_FOUND", "工作区不存在");

  const ancestors: DirectoryNode[] = [];
  let parentId = item.parentId;

  while (parentId) {
    const parent = await directoryItem(workspaceId, userId, {
      kind: "folder",
      id: parentId,
    });

    if (!parent || parent.kind !== "folder")
      return fail(404, "NOT_FOUND", "目录路径不存在");
    ancestors.unshift(parent);
    parentId = parent.parentId;
  }

  const pathItems = [...ancestors, item];
  const pages: DirectoryPage[] = [];

  for (const pathItem of pathItems) {
    const previous = await previousSibling(workspaceId, pathItem);
    const page = previous
      ? await directoryPage(
          workspaceId,
          userId,
          pathItem.parentId,
          30,
          cursorAfter(workspaceId, pathItem.parentId, revision, previous),
        )
      : await directoryPage(workspaceId, userId, pathItem.parentId, 30);

    page.hasPrevious = previous !== null;
    pages.push(page);
  }

  const latest = (
    await db
      .select({ revision: tables.workspaces.catalogRevision })
      .from(tables.workspaces)
      .where(
        and(
          eq(tables.workspaces.id, workspaceId),
          eq(tables.workspaces.userId, userId),
          eq(tables.workspaces.deleting, 0),
          isNull(tables.workspaces.deletedAt),
        ),
      )
      .limit(1)
  )[0]?.revision;

  if (latest !== revision)
    throw new ApiError(409, "CATALOG_CONFLICT", "目录已更新，请重新定位");

  return { ancestors, item, catalogRevision: revision, pages };
}
