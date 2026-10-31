import { computed, onBeforeUnmount, ref, shallowReadonly, watch } from "vue";
import type { Ref } from "vue";
import type { CanvasMeta } from "#shared/contracts";
import type {
  DirectoryNode,
  DirectoryPage,
  NodeRef,
} from "#shared/directory-contracts";
import { ApiError } from "~/lib/api";
import { directoryApi, nodeKey } from "~/lib/directory-api";
import type { DirectoryApi, DirectoryMove } from "~/lib/directory-api";
import { confirmDialog } from "~/lib/dialogs";

export interface DirectoryBranch {
  page?: DirectoryPage;
  loading: boolean;
  error: string;
}

export interface DirectoryTreeDependencies {
  workspaceId: Readonly<Ref<string>>;
  owner: () => string | undefined;
  locked: Readonly<Ref<boolean>>;
  api?: DirectoryApi;
  flush(): Promise<void>;
  remember(canvas: CanvasMeta): void;
  open(canvas: CanvasMeta): Promise<void>;
  renamed(id: string, name: string): void;
  removed(ids: string[]): Promise<void> | void;
  knownCanvasIds(): string[];
}

/** 组织树仅拥有元数据和分页；编辑器、草稿与标签仍由原目录/画布资源拥有。 */
export const useDirectoryTree = (options: DirectoryTreeDependencies) => {
  const api = options.api ?? directoryApi;
  const branches = ref<Record<string, DirectoryBranch>>({});
  const expanded = ref<string[]>([]);
  const favorites = ref<DirectoryNode[]>([]);
  const known = ref<Record<string, DirectoryNode>>({});
  const revision = ref(0);
  const busy = ref(false);
  const stale = ref(false);
  const refreshing = ref(false);
  const error = ref("");
  const located = ref("");
  const locateVersion = ref(0);
  const locateExpandRoot = ref(true);
  const undo = ref<DirectoryNode>();
  const moveUndo = ref<Omit<DirectoryMove, "catalogRevision">>();
  const restoreLocationRequired = ref(false);
  const ancestry = ref<DirectoryNode[]>([]);
  let generation = 0;
  let revealRequest = 0;
  let pathRequest = 0;
  let pathSource: NodeRef | undefined;
  let refreshFlight: Promise<void> | undefined;
  let abort = new AbortController();
  const branchKey = (id: string | null) => id ?? "";
  const current = () => `${options.owner() ?? ""}:${options.workspaceId.value}`;
  const locked = computed(
    () =>
      options.locked.value ||
      busy.value ||
      refreshing.value ||
      stale.value ||
      !branches.value[""]?.page,
  );
  const remember = (items: DirectoryNode[]) => {
    for (const item of items) {
      known.value[nodeKey(item)] = item;
      if (item.kind === "canvas") options.remember(item.canvas);
    }
  };
  const publish = (page: DirectoryPage, append = false) => {
    const key = branchKey(page.parentId);
    const previous = branches.value[key]?.page;
    const items =
      append && previous ? [...previous.items, ...page.items] : page.items;

    remember(page.items);
    branches.value[key] = {
      loading: false,
      error: "",
      page: {
        ...page,
        items: [
          ...new Map(items.map((item) => [nodeKey(item), item])).values(),
        ],
        hasPrevious: append ? previous?.hasPrevious : page.hasPrevious,
      },
    };
    revision.value = page.catalogRevision;
  };
  const report = (cause: unknown) => {
    error.value =
      cause instanceof Error ? cause.message : "目录操作失败，请重试。";
  };
  const load = async (parentId: string | null, append = false) => {
    const workspace = options.workspaceId.value;
    const key = branchKey(parentId);
    const previous = branches.value[key];
    const stamp = generation;

    if (
      !workspace ||
      previous?.loading ||
      (append && !previous?.page?.nextCursor)
    )
      return;
    branches.value[key] = { ...previous, loading: true, error: "" };
    try {
      const page = await api.children(
        workspace,
        parentId,
        append ? (previous?.page?.nextCursor ?? undefined) : undefined,
        abort.signal,
      );

      if (stamp !== generation) return;
      if (
        (append && page.catalogRevision !== previous?.page?.catalogRevision) ||
        (branches.value[""]?.page && revision.value !== page.catalogRevision)
      ) {
        throw new ApiError(409, "CATALOG_CONFLICT", "目录已更新，请重新加载。");
      }

      publish(page, append);
    } catch (cause) {
      if (stamp !== generation) return;
      branches.value[key] = {
        ...previous,
        loading: false,
        error: cause instanceof Error ? cause.message : "加载失败，请重试",
      };
      if (cause instanceof ApiError && cause.code === "CATALOG_CONFLICT") {
        stale.value = true;
        try {
          // Refresh reads the loaded range directly, never by recursively appending.
          // Its single flight coalesces conflicts from multiple visible branches.
          await refresh();
        } catch (refreshCause) {
          if (stamp !== generation) return;
          report(refreshCause);
        }
      }
    }
  };
  const forgetFolders = (ids: string[]) => {
    for (const id of ids) {
      delete branches.value[id];
      delete known.value[`folder:${id}`];
    }

    expanded.value = expanded.value.filter((id) => !ids.includes(id));
  };
  const forgetSubtree = (source: DirectoryNode) => {
    if (source.kind !== "folder") return;
    const ids = [source.id];

    for (let index = 0; index < ids.length; index++) {
      for (const item of Object.values(known.value)) {
        if (
          item.kind === "folder" &&
          item.parentId === ids[index] &&
          !ids.includes(item.id)
        )
          ids.push(item.id);
      }
    }

    forgetFolders(ids);
  };
  const refreshPage = async (workspace: string, key: string) => {
    const previous = branches.value[key]?.page;
    const first = previous?.items[0];

    if (previous?.hasPrevious && first) {
      try {
        const located = await api.path(workspace, first, abort.signal);
        const page = located.pages.find(
          (entry) => entry.parentId === (key || null),
        );

        if (page) return page;
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 404) throw cause;
      }
    }

    return api.children(workspace, key || null, undefined, abort.signal);
  };
  const refreshNow = async () => {
    const stamp = generation;
    const workspace = options.workspaceId.value;
    const parents = Object.keys(branches.value);

    if (!workspace) return;
    const next: DirectoryPage[] = [];

    refreshing.value = true;
    try {
      for (const key of parents.length ? parents : [""]) {
        const length = Math.max(
          30,
          branches.value[key]?.page?.items.length ?? 0,
        );
        let page: DirectoryPage;

        try {
          page = await refreshPage(workspace, key);
        } catch (cause) {
          if (!key || !(cause instanceof ApiError) || cause.status !== 404)
            throw cause;
          forgetFolders([key]);
          continue;
        }

        const hasPrevious = page.hasPrevious;
        const items = [...page.items];

        while (items.length < length && page.nextCursor) {
          const following = await api.children(
            workspace,
            key || null,
            page.nextCursor,
            abort.signal,
          );

          if (following.catalogRevision !== page.catalogRevision)
            throw new ApiError(409, "CATALOG_CONFLICT", "目录已更新");
          items.push(...following.items);
          page = following;
        }

        next.push({ ...page, items, hasPrevious });
      }

      const saved = await api.favorites(workspace, abort.signal);

      if (stamp !== generation) return;
      if (next.some((page) => page.catalogRevision !== saved.catalogRevision))
        throw new ApiError(409, "CATALOG_CONFLICT", "目录已更新，请重新加载。");
      next.forEach((page) => publish(page));
      favorites.value = saved.items;
      remember(saved.items);
      revision.value = saved.catalogRevision;
      stale.value = false;
      if (pathSource) {
        try {
          await readPath(pathSource);
        } catch (cause) {
          if (
            !(cause instanceof ApiError) ||
            cause.status !== 404 ||
            pathSource.kind !== "canvas"
          )
            throw cause;
          const removedId = pathSource.id;

          await options.removed([removedId]);
          if (stamp !== generation) return;
          if (pathSource?.kind === "canvas" && pathSource.id === removedId) {
            pathSource = undefined;
            ancestry.value = [];
          }
        }
      }
    } catch (cause) {
      if (stamp !== generation) return;
      stale.value = true;
      throw cause;
    } finally {
      if (stamp === generation) refreshing.value = false;
    }
  };
  const refresh = (): Promise<void> => {
    if (refreshFlight) return refreshFlight;
    const pending = refreshNow().finally(() => {
      if (refreshFlight === pending) refreshFlight = undefined;
    });

    refreshFlight = pending;

    return pending;
  };
  const attempt = async (action: () => Promise<void>) => {
    const stamp = generation;

    error.value = "";
    try {
      await action();
    } catch (cause) {
      if (stamp === generation) report(cause);
    }
  };
  const mutate = async (
    action: (workspace: string, catalogRevision: number) => Promise<void>,
    confirmed?: () => Promise<boolean>,
  ) => {
    if (locked.value) return false;
    refreshFlight = undefined;
    generation++;
    abort.abort();
    abort = new AbortController();
    const stamp = generation;
    const workspace = options.workspaceId.value;
    let failure: unknown;

    busy.value = true;
    error.value = "";
    try {
      try {
        await action(workspace, revision.value);
      } catch (cause) {
        failure = cause;
      }

      if (stamp !== generation) return false;
      let reconciled = false;

      if (failure && confirmed) {
        try {
          reconciled = await confirmed();
        } catch (cause) {
          failure = new Error("操作结果尚未确认，请检查最新目录。", { cause });
        }
      }

      await refresh();
      if (stamp !== generation) return false;
      if (failure && !reconciled) throw failure;

      return true;
    } catch (cause) {
      if (stamp === generation) report(cause);

      return false;
    } finally {
      if (stamp === generation) busy.value = false;
    }
  };
  const toggle = async (item: DirectoryNode) => {
    if (item.kind !== "folder") return;
    if (expanded.value.includes(item.id))
      expanded.value = expanded.value.filter((id) => id !== item.id);
    else {
      expanded.value.push(item.id);
      if (!branches.value[item.id]?.page) await load(item.id);
    }
  };
  const reveal = async (
    source: NodeRef,
    expandTarget = false,
    expandRoot = true,
  ) => {
    const stamp = generation;
    const request = ++revealRequest;

    await refreshFlight;
    if (stamp !== generation || request !== revealRequest) return;
    const result = await api.path(
      options.workspaceId.value,
      source,
      abort.signal,
    );

    if (stamp !== generation || request !== revealRequest) return;
    const pathItems = [...result.ancestors, result.item];

    for (const page of result.pages) {
      const previous = branches.value[branchKey(page.parentId)]?.page;
      const target = pathItems.find((item) => item.parentId === page.parentId);
      const containsTarget =
        target &&
        previous?.items.some((item) => nodeKey(item) === nodeKey(target));

      if (
        previous?.catalogRevision === page.catalogRevision &&
        containsTarget
      ) {
        const updated = new Map(
          page.items.map((item) => [nodeKey(item), item]),
        );

        publish({
          ...previous,
          items: previous.items.map(
            (item) => updated.get(nodeKey(item)) ?? item,
          ),
        });
      } else {
        publish(page);
      }
    }

    remember(pathItems);
    for (const folder of result.ancestors) {
      if (!expanded.value.includes(folder.id)) expanded.value.push(folder.id);
    }

    located.value = nodeKey(source);
    locateExpandRoot.value = expandRoot;
    locateVersion.value++;
    if (
      expandTarget &&
      result.item.kind === "folder" &&
      !expanded.value.includes(result.item.id)
    )
      await toggle(result.item);
  };
  const readPath = async (source?: NodeRef) => {
    const stamp = generation;
    const request = ++pathRequest;

    pathSource = source;

    if (!source) {
      ancestry.value = [];

      return;
    }

    const result = await api.path(
      options.workspaceId.value,
      source,
      abort.signal,
    );

    if (stamp === generation && request === pathRequest)
      ancestry.value = result.ancestors;
  };
  const open = async (item: DirectoryNode) => {
    if (options.locked.value || busy.value) return;
    if (item.kind === "folder") await toggle(item);
    else await options.open(item.canvas);
  };
  const create = async (
    kind: NodeRef["kind"],
    name: string,
    parentId: string | null,
  ) => {
    let created: DirectoryNode | CanvasMeta | undefined;
    const accepted = await mutate(async (workspace, version) => {
      if (kind === "canvas") await options.flush();
      created = await api.create(workspace, kind, name, parentId, version);
    });

    if (!accepted || !created) return false;
    if (kind === "canvas") {
      const canvas =
        "kind" in created && created.kind === "canvas"
          ? created.canvas
          : (created as CanvasMeta);

      options.remember(canvas);
      await options.open(canvas);
      await attempt(() => reveal({ kind, id: canvas.id }));
    } else await attempt(() => reveal({ kind, id: created!.id }));

    return true;
  };
  const rename = async (item: DirectoryNode, name: string) =>
    mutate(
      async (_workspace, version) => {
        await api.rename(item, name, version);
        if (item.kind === "canvas") options.renamed(item.id, name);
      },
      async () => {
        const result = await api.path(options.workspaceId.value, item);

        if (result.item.name === name && item.kind === "canvas")
          options.renamed(item.id, name);

        return result.item.name === name;
      },
    );
  const confirmMove = async (input: Omit<DirectoryMove, "catalogRevision">) => {
    const result = await api.path(
      options.workspaceId.value,
      input.source,
      abort.signal,
    );

    if (result.item.parentId !== input.parentId) return false;
    const page = result.pages.find(
      (entry) => entry.parentId === input.parentId,
    );

    if (input.placement === "end")
      return page?.items.length === 1 && !page.nextCursor;
    if (!input.target) return false;
    if (input.placement === "before")
      return (
        nodeKey(page?.items[1] ?? { kind: "canvas", id: "" }) ===
        nodeKey(input.target)
      );
    const target = await api.path(
      options.workspaceId.value,
      input.target,
      abort.signal,
    );
    const targetPage = target.pages.find(
      (entry) => entry.parentId === input.parentId,
    );

    return (
      nodeKey(targetPage?.items[1] ?? { kind: "canvas", id: "" }) ===
      nodeKey(input.source)
    );
  };
  const readMoveOrigin = async (
    workspace: string,
    source: NodeRef,
    version: number,
  ): Promise<Omit<DirectoryMove, "catalogRevision">> => {
    const path = await api.path(workspace, source, abort.signal);

    if (path.catalogRevision !== version) {
      throw new ApiError(409, "CATALOG_CONFLICT", "目录已更新，请重新移动。");
    }

    const page = path.pages.find(
      (item) => item.parentId === path.item.parentId,
    );

    if (!page || !page.items[0] || nodeKey(page.items[0]) !== nodeKey(source)) {
      throw new ApiError(502, "INVALID_RESPONSE", "无法确认原位置，尚未移动。");
    }

    let next = page.items[1];

    if (!next && page.nextCursor) {
      const following = await api.children(
        workspace,
        path.item.parentId,
        page.nextCursor,
        abort.signal,
      );

      if (following.catalogRevision !== version) {
        throw new ApiError(409, "CATALOG_CONFLICT", "目录已更新，请重新移动。");
      }

      next = following.items[0];
      if (!next) {
        throw new ApiError(
          502,
          "INVALID_RESPONSE",
          "无法确认原位置，尚未移动。",
        );
      }
    }

    return {
      source,
      parentId: path.item.parentId,
      target: next ? { kind: next.kind, id: next.id } : undefined,
      placement: next ? "before" : "end",
    };
  };
  const move = async (input: Omit<DirectoryMove, "catalogRevision">) => {
    const source = known.value[nodeKey(input.source)];
    const siblings = branches.value[source?.parentId ?? ""]?.page?.items ?? [];
    const index = siblings.findIndex(
      (item) => nodeKey(item) === nodeKey(input.source),
    );
    const next = index >= 0 ? siblings[index + 1] : undefined;
    const previous = index >= 0 ? siblings[index - 1] : undefined;
    const target = next ?? previous;
    let reverse: Omit<DirectoryMove, "catalogRevision"> | undefined =
      index >= 0
        ? {
            source: input.source,
            parentId: source?.parentId ?? null,
            target,
            placement: next ? "before" : previous ? "after" : "end",
          }
        : undefined;
    let writeAttempted = false;
    const accepted = await mutate(
      async (workspace, version) => {
        if (!reverse)
          reverse = await readMoveOrigin(workspace, input.source, version);
        writeAttempted = true;
        await api.move(workspace, { ...input, catalogRevision: version });
      },
      () => (writeAttempted ? confirmMove(input) : Promise.resolve(false)),
    );

    if (accepted) {
      if (reverse) moveUndo.value = reverse;
      await attempt(() => reveal(input.source));
    }

    return accepted;
  };
  const undoMove = async () => {
    const input = moveUndo.value;

    if (!input) return;
    const accepted = await mutate(
      (workspace, version) =>
        api.move(workspace, { ...input, catalogRevision: version }),
      () => confirmMove(input),
    );

    if (accepted) {
      moveUndo.value = undefined;
      await attempt(() => reveal(input.source));
    }
  };
  const favorite = async (item: DirectoryNode, value = !item.favorite) =>
    mutate(
      (workspace, version) => api.favorite(workspace, item, value, version),
      async () => {
        const saved = await api.favorites(
          options.workspaceId.value,
          abort.signal,
        );

        return (
          saved.items.some((entry) => nodeKey(entry) === nodeKey(item)) ===
          value
        );
      },
    );
  const orderFavorite = async (
    source: NodeRef,
    target: NodeRef,
    placement: "before" | "after",
  ) =>
    mutate(
      (workspace, version) =>
        api.orderFavorite(workspace, source, target, placement, version),
      async () => {
        const saved = await api.favorites(
          options.workspaceId.value,
          abort.signal,
        );
        const sourceIndex = saved.items.findIndex(
          (item) => nodeKey(item) === nodeKey(source),
        );
        const targetIndex = saved.items.findIndex(
          (item) => nodeKey(item) === nodeKey(target),
        );

        return (
          sourceIndex >= 0 &&
          targetIndex >= 0 &&
          sourceIndex === targetIndex + (placement === "before" ? -1 : 1)
        );
      },
    );
  const confirmMissingCanvases = async (
    workspace: string,
    candidates: string[],
  ) => {
    const stamp = generation;
    const missing: string[] = [];

    for (const id of candidates) {
      try {
        await api.path(workspace, { kind: "canvas", id }, abort.signal);
      } catch (cause) {
        if (stamp !== generation) return [];
        if (!(cause instanceof ApiError) || cause.status !== 404) throw cause;
        missing.push(id);
      }

      if (stamp !== generation) return [];
    }

    // Only one handoff after every candidate has been checked; otherwise a
    // still-unchecked sibling from the same deleted batch could open briefly.
    await options.removed(missing);

    return missing;
  };
  const remove = async (item: DirectoryNode) => {
    if (locked.value) return;
    const workspace = options.workspaceId.value;
    const summary =
      item.kind === "folder" ? await api.summary(item.id) : undefined;
    const confirmed = await confirmDialog({
      title: "移入回收站",
      message: `将「${item.name}」${summary ? `及其中 ${summary.folderCount} 个文件夹、${summary.canvasCount} 张画布` : ""}移入回收站？30 天内可以恢复。`,
      confirmLabel: "移入回收站",
      danger: true,
    });

    if (!confirmed || workspace !== options.workspaceId.value) return;
    let mutationStamp = generation;

    await mutate(
      async (_workspace, version) => {
        mutationStamp = generation;
        await options.flush();
        const result = await api.remove(
          item,
          summary?.catalogRevision ?? version,
        );

        if (
          mutationStamp !== generation ||
          workspace !== options.workspaceId.value
        )
          return;
        forgetFolders(result.affectedFolderIds ?? []);
        forgetSubtree(item);
        await options.removed(result.affectedCanvasIds);
        if (
          mutationStamp !== generation ||
          workspace !== options.workspaceId.value
        )
          return;
        undo.value = item;
      },
      async () => {
        try {
          await api.path(workspace, item);

          return false;
        } catch (cause) {
          if (!(cause instanceof ApiError) || cause.status !== 404) throw cause;
          if (
            mutationStamp !== generation ||
            workspace !== options.workspaceId.value
          )
            return false;
          await confirmMissingCanvases(workspace, options.knownCanvasIds());
          if (
            mutationStamp !== generation ||
            workspace !== options.workspaceId.value
          )
            return false;
          forgetSubtree(item);
          undo.value = item;

          return true;
        }
      },
    );
  };
  const restore = async (parentId?: string | null) => {
    const item = undo.value;

    if (!item) return;
    const accepted = await mutate(
      async () => {
        try {
          await api.restore(item, parentId);
        } catch (cause) {
          if (
            cause instanceof ApiError &&
            cause.code === "RESTORE_LOCATION_REQUIRED"
          )
            restoreLocationRequired.value = true;
          throw cause;
        }
      },
      async () => {
        try {
          await api.path(options.workspaceId.value, item, abort.signal);

          return true;
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 404) return false;
          throw cause;
        }
      },
    );

    if (accepted) {
      undo.value = undefined;
      restoreLocationRequired.value = false;
      await attempt(() => reveal(item, item.kind === "folder"));
    }
  };
  const reset = () => {
    generation++;
    revealRequest++;
    pathRequest++;
    pathSource = undefined;
    refreshFlight = undefined;
    abort.abort();
    abort = new AbortController();
    branches.value = {};
    expanded.value = [];
    favorites.value = [];
    known.value = {};
    ancestry.value = [];
    located.value = "";
    undo.value = undefined;
    moveUndo.value = undefined;
    restoreLocationRequired.value = false;
    busy.value = false;
    refreshing.value = false;
    stale.value = false;
    error.value = "";
  };

  watch(
    current,
    () => {
      reset();
      if (options.owner() && options.workspaceId.value) void attempt(refresh);
    },
    { immediate: true },
  );
  onBeforeUnmount(reset);

  return {
    branches: shallowReadonly(branches),
    expanded: shallowReadonly(expanded),
    favorites: shallowReadonly(favorites),
    known: shallowReadonly(known),
    ancestry: shallowReadonly(ancestry),
    revision: shallowReadonly(revision),
    busy: shallowReadonly(busy),
    refreshing: shallowReadonly(refreshing),
    stale: shallowReadonly(stale),
    error,
    located: shallowReadonly(located),
    locateVersion: shallowReadonly(locateVersion),
    locateExpandRoot: shallowReadonly(locateExpandRoot),
    undo: shallowReadonly(undo),
    moveUndo: shallowReadonly(moveUndo),
    restoreLocationRequired: shallowReadonly(restoreLocationRequired),
    locked,
    load,
    refresh,
    attempt,
    toggle,
    reveal,
    readPath,
    open,
    create,
    rename,
    move,
    favorite,
    orderFavorite,
    remove,
    restore,
    undoMove,
    cancelRestoreLocation: () => {
      restoreLocationRequired.value = false;
    },
  };
};

export type DirectoryTreeController = ReturnType<typeof useDirectoryTree>;
