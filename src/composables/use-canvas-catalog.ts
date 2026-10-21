import { ref } from "vue";
import type {
  CanvasCatalog,
  CanvasCatalogPage,
  CanvasMeta,
} from "#shared/contracts";
import type { WorkspaceApi } from "~/lib/workspaceApi";
import { ApiError } from "~/lib/api";

type CatalogApi = Pick<WorkspaceApi, "readCatalog"> &
  Partial<Pick<WorkspaceApi, "readCatalogPage">>;

/** Loaded order is a window into the catalog; known metadata also owns off-page tabs. */
export const useCanvasCatalog = (api: CatalogApi) => {
  const canvases = ref<CanvasMeta[]>([]);
  const known = ref<Record<string, CanvasMeta>>({});
  const total = ref(0);
  const nextCursor = ref<string | null>(null);
  const catalogRevision = ref(0);
  const directoryStale = ref(false);
  const loadingMore = ref(false);
  const paginationError = ref("");
  const refreshing = ref(false);
  let generation = 0;
  let abort = new AbortController();
  let pending: Promise<void> | undefined;

  const cancel = () => {
    generation++;
    abort.abort();
    abort = new AbortController();
    pending = undefined;
    loadingMore.value = false;
    refreshing.value = false;
  };
  const remember = (canvas: CanvasMeta) => {
    const {
      id,
      workspaceId,
      name,
      pinned,
      syncMode,
      roomEpoch,
      migrationEpoch,
      position,
      revision,
      createdAt,
      updatedAt,
    } = canvas;

    known.value[id] = {
      id,
      workspaceId,
      name,
      pinned,
      syncMode,
      roomEpoch,
      migrationEpoch,
      position,
      revision,
      createdAt,
      updatedAt,
    };
  };
  const publish = (page: CanvasCatalogPage) => {
    page.canvases.forEach(remember);
    canvases.value = page.canvases;
    total.value = page.total;
    nextCursor.value = page.nextCursor;
    catalogRevision.value = page.catalogRevision;
    directoryStale.value = false;
    paginationError.value = "";
  };
  const normalize = (catalog: CanvasCatalog): CanvasCatalogPage => ({
    ...catalog,
    total: catalog.canvases.length,
    nextCursor: null,
  });
  const read = async (
    id: string,
    cursor?: string,
    limit = 30,
  ): Promise<CanvasCatalogPage> => {
    if (api.readCatalogPage) {
      const page = await api.readCatalogPage(id, {
        limit,
        cursor,
        signal: abort.signal,
      });

      return {
        ...page,
        total: page.total ?? page.canvases.length,
        nextCursor: page.nextCursor ?? null,
      };
    }

    return normalize(await api.readCatalog(id));
  };
  const refresh = async (id: string) => {
    const length = Math.max(30, canvases.value.length);

    cancel();
    const stamp = generation;

    refreshing.value = true;
    try {
      let page = await read(id, undefined, Math.min(100, length));

      if (stamp !== generation) {
        return;
      }

      const revision = page.catalogRevision;
      const entries = [...page.canvases];

      while (entries.length < length && page.nextCursor) {
        page = await read(
          id,
          page.nextCursor,
          Math.min(100, length - entries.length),
        );
        if (stamp !== generation) {
          return;
        }

        if (page.catalogRevision !== revision) {
          throw new ApiError(409, "CATALOG_CONFLICT", "目录版本已更新");
        }

        entries.push(...page.canvases);
      }

      if (stamp === generation) {
        publish({ ...page, canvases: entries });
      }
    } catch (cause) {
      if (stamp !== generation) {
        return;
      }

      directoryStale.value = true;
      paginationError.value = "未能确认最新画布列表，请重试。";
      throw new Error("未能确认最新画布列表，请重新加载列表后再操作。", {
        cause,
      });
    } finally {
      if (stamp === generation) {
        refreshing.value = false;
      }
    }
  };
  const loadNext = (id: string): Promise<void> => {
    if (pending) {
      return pending;
    }

    if (!nextCursor.value || refreshing.value || directoryStale.value) {
      return Promise.resolve();
    }

    const stamp = generation;
    const cursor = nextCursor.value;
    const revision = catalogRevision.value;

    loadingMore.value = true;
    paginationError.value = "";
    pending = (async () => {
      try {
        const page = await read(id, cursor);

        if (stamp !== generation) {
          return;
        }

        if (page.catalogRevision !== revision) {
          throw new ApiError(409, "CATALOG_CONFLICT", "目录版本已更新");
        }

        const entries = new Map(
          canvases.value.map((canvas) => [canvas.id, canvas]),
        );

        page.canvases.forEach((canvas) => entries.set(canvas.id, canvas));
        publish({ ...page, canvases: [...entries.values()] });
      } catch (error) {
        if (stamp !== generation) {
          return;
        }

        if (error instanceof ApiError && error.code === "CATALOG_CONFLICT") {
          try {
            await refresh(id);
          } catch (cause) {
            paginationError.value =
              cause instanceof Error ? cause.message : "加载失败，请重试。";
          }
        } else {
          paginationError.value =
            error instanceof Error ? error.message : "加载失败，请重试。";
        }
      } finally {
        if (stamp === generation) {
          loadingMore.value = false;
          pending = undefined;
        }
      }
    })();

    return pending;
  };
  const forgetWorkspace = (id: string) => {
    for (const canvas of Object.values(known.value)) {
      if (canvas.workspaceId === id) {
        delete known.value[canvas.id];
      }
    }
  };
  const reset = () => {
    cancel();
    canvases.value = [];
    known.value = {};
    total.value = 0;
    nextCursor.value = null;
    catalogRevision.value = 0;
    directoryStale.value = false;
    paginationError.value = "";
  };

  return {
    canvases,
    known,
    total,
    nextCursor,
    catalogRevision,
    directoryStale,
    loadingMore,
    paginationError,
    refreshing,
    cancel,
    getReadSignal: () => abort.signal,
    read,
    publish,
    normalize,
    refresh,
    loadNext,
    remember,
    forgetWorkspace,
    reset,
  };
};
