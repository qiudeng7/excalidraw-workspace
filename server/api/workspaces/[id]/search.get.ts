import { ApiError, fail, json } from "#server/utils/http";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { requireUser } from "#server/utils/auth";
import { requireWorkspace } from "#server/utils/access";
import { apiRequest } from "#server/utils/request";
import { principal, readSearchScene } from "#server/collaboration/service";
import {
  confirmWorkspaceSearchRevision,
  workspaceSearchBatch,
} from "#server/db/workspace-search";
import {
  searchCanvas,
  type SearchPage,
  type SearchSkippedCanvas,
} from "#shared/workspace-search";

const MAX_QUERY_LENGTH = 64;
const SKIPPED_SCENE_CODES = new Set([
  "SEARCH_SCENE_NOT_READY",
  "SEARCH_SCENE_UNAVAILABLE",
  "ROOM_NOT_FOUND",
  "RECYCLE_SYNC_PENDING",
  "ROOM_BUSY",
]);

const singleParameter = (parameters: URLSearchParams, key: string) => {
  const values = parameters.getAll(key);

  if (values.length > 1)
    return fail(400, "INVALID_SEARCH_QUERY", "搜索参数无效");

  return values[0];
};

const searchRequest = (event: Parameters<typeof apiRequest>[0]) => {
  const parameters = new URL(apiRequest(event).url).searchParams;
  const rawQuery = singleParameter(parameters, "q");
  const query = rawQuery?.trim();
  const cursor = singleParameter(parameters, "cursor");
  const currentCanvasId = singleParameter(parameters, "currentCanvasId");

  if (!query || query.length > MAX_QUERY_LENGTH)
    return fail(400, "INVALID_SEARCH_QUERY", "搜索内容需为 1–64 个字符");
  if (currentCanvasId !== undefined && currentCanvasId.length > 200)
    return fail(400, "INVALID_SEARCH_QUERY", "当前画布标识无效");

  return { query, cursor, currentCanvasId };
};

const skippedCode = (cause: unknown) =>
  cause instanceof ApiError && SKIPPED_SCENE_CODES.has(cause.code)
    ? cause.code
    : undefined;

export default defineApiHandler(async (event) => {
  const workspaceId = resourceId(event);
  const user = await requireUser(event);

  await requireWorkspace(workspaceId, user);
  const request = searchRequest(event);
  const batch = await workspaceSearchBatch(workspaceId, user.id, {
    cursor: request.cursor,
    currentCanvasId: request.currentCanvasId,
  });
  const actor = await principal(event);

  if (actor.userId !== user.id || actor.capabilityHash)
    return fail(403, "SEARCH_ACCESS_DENIED", "无权搜索此工作空间");

  const groups: NonNullable<SearchPage["groups"]> = [];
  const skipped: SearchSkippedCanvas[] = [];
  let nextIndex = 0;
  const scan = async () => {
    for (;;) {
      const index = nextIndex++;
      const candidate = batch.candidates[index];

      if (!candidate) return;
      try {
        const scene = await readSearchScene(
          event,
          candidate.id,
          workspaceId,
          user.id,
          actor,
        );
        const group = searchCanvas(
          {
            id: candidate.id,
            name: scene.name,
            workspaceId,
            folderPath: candidate.folderPath,
          },
          scene.elements,
          request.query,
        );

        if (group) groups[index] = group;
      } catch (cause) {
        const code = skippedCode(cause);

        if (!code) throw cause;
        skipped.push({ canvasId: candidate.id, code });
      }
    }
  };

  await Promise.all([scan(), scan()]);
  await confirmWorkspaceSearchRevision(
    workspaceId,
    user.id,
    batch.catalogRevision,
  );

  return json({
    groups: groups.filter(Boolean),
    nextCursor: batch.nextCursor,
    catalogRevision: batch.catalogRevision,
    ...(batch.validatedCurrentCanvasId
      ? { validatedCurrentCanvasId: batch.validatedCurrentCanvasId }
      : {}),
    skipped,
  } satisfies SearchPage);
});
