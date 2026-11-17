import { computed, onScopeDispose, ref, watch } from "vue";
import type { CanvasSearchGroup, SearchPage } from "#shared/workspace-search";
import { searchCanvas } from "#shared/workspace-search";
import type { EditorSearchScene } from "~/lib/editor";
import { ApiError } from "~/lib/api";

import type { WorkspaceSearchRequest } from "~/lib/workspaceApi";

export interface WorkspaceSearchContext {
  ownerId: string;
  workspaceId: string;
  canvas?: {
    id: string;
    name: string;
    workspaceId: string;
    folderPath?: string;
  };
}

/** One query owns its pages; local displayed content replaces, never appends to, its cloud group. */
export const useWorkspaceSearch = (options: {
  context: () => WorkspaceSearchContext;
  readScene: () => EditorSearchScene | undefined;
  search: (
    workspaceId: string,
    request: WorkspaceSearchRequest,
  ) => Promise<SearchPage>;
}) => {
  const open = ref(false);
  const query = ref("");
  const groups = ref<CanvasSearchGroup[]>([]);
  const loading = ref(false);
  const complete = ref(false);
  const error = ref("");
  const skipped = ref<string[]>([]);
  let epoch = 0;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cursor: string | undefined;
  let restarts = 0;
  let cloudGroups = new Map<string, CanvasSearchGroup>();
  let skippedIds = new Set<string>();

  const invalidate = () => {
    epoch++;
    clearTimeout(timer);
    controller?.abort();
    controller = undefined;
    loading.value = false;
  };
  const resetResults = () => {
    cloudGroups = new Map();
    skippedIds = new Set();
    groups.value = [];
    skipped.value = [];
    cursor = undefined;
    complete.value = false;
    error.value = "";
  };
  const publish = (
    page: SearchPage,
    context: WorkspaceSearchContext,
    text: string,
  ) => {
    for (const group of page.groups) cloudGroups.set(group.canvas.id, group);
    for (const item of page.skipped) skippedIds.add(item.canvasId);
    const result = new Map(cloudGroups);
    const scene = options.readScene();
    const canvas = context.canvas;

    if (
      canvas &&
      page.validatedCurrentCanvasId === canvas.id &&
      scene?.canvasId === canvas.id
    ) {
      result.delete(canvas.id);
      const local = searchCanvas(
        {
          ...canvas,
          folderPath:
            canvas.folderPath ?? cloudGroups.get(canvas.id)?.canvas.folderPath,
        },
        scene.elements,
        text,
      );

      if (local) result.set(canvas.id, local);
      skippedIds.delete(canvas.id);
    }

    groups.value = [...result.values()].sort((a, b) =>
      a.canvas.id === canvas?.id
        ? -1
        : b.canvas.id === canvas?.id
          ? 1
          : a.canvas.id.localeCompare(b.canvas.id),
    );
    skipped.value = [...skippedIds];
  };
  const sameContext = (context: WorkspaceSearchContext) => {
    const current = options.context();

    return (
      context.ownerId === current.ownerId &&
      context.workspaceId === current.workspaceId &&
      context.canvas?.id === current.canvas?.id
    );
  };
  const load = async () => {
    const text = query.value.trim();
    const context = options.context();

    if (
      !open.value ||
      !text ||
      !context.ownerId ||
      !context.workspaceId ||
      loading.value
    )
      return;
    const requestEpoch = epoch;
    const flight = new AbortController();

    controller = flight;
    loading.value = true;
    error.value = "";
    try {
      let more = true;

      while (more && requestEpoch === epoch && sameContext(context)) {
        const page = await options.search(context.workspaceId, {
          query: text,
          cursor,
          currentCanvasId: context.canvas?.id,
          signal: flight.signal,
        });

        if (requestEpoch !== epoch || !open.value || !sameContext(context))
          return;
        publish(page, context, text);
        cursor = page.nextCursor || undefined;
        more = !!cursor;
      }

      if (requestEpoch === epoch) complete.value = true;
    } catch (cause) {
      if (requestEpoch !== epoch || flight.signal.aborted) return;
      if (
        cause instanceof ApiError &&
        cause.code === "SEARCH_CATALOG_CHANGED"
      ) {
        resetResults();
        if (restarts++ === 0) {
          loading.value = false;
          await load();

          return;
        }
      }

      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status))
        resetResults();
      error.value =
        cause instanceof Error ? cause.message : "搜索未完成，请重试";
    } finally {
      if (requestEpoch === epoch) loading.value = false;
    }
  };
  const schedule = () => {
    invalidate();
    resetResults();
    restarts = 0;
    if (open.value && query.value.trim())
      timer = setTimeout(() => {
        void load();
      }, 200);
  };
  const setQuery = (value: string) => {
    if (query.value === value) return;
    query.value = value;
    schedule();
  };
  const show = () => {
    if (open.value) return;
    open.value = true;
    schedule();
  };
  const close = () => {
    open.value = false;
    invalidate();
    resetResults();
  };

  watch(
    () => `${options.context().ownerId}\u0000${options.context().workspaceId}`,
    () => {
      close();
      query.value = "";
    },
  );
  watch(
    () => options.context().canvas?.id,
    () => {
      if (open.value) schedule();
    },
  );
  onScopeDispose(invalidate);

  return {
    open,
    query,
    groups,
    loading,
    complete,
    error,
    skipped,
    resultCount: computed(() =>
      groups.value.reduce(
        (count, group) => count + group.matches.length + 1,
        0,
      ),
    ),
    setQuery,
    show,
    close,
    retry: () => {
      if (complete.value) schedule();
      else {
        restarts = 0;
        void load();
      }
    },
  };
};

export type WorkspaceSearchController = ReturnType<typeof useWorkspaceSearch>;
