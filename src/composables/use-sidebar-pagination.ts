import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { Ref } from "vue";

type ReadonlyRef<T> = Readonly<Ref<T>>;

interface SidebarPaginationOptions {
  owner: () => string | undefined;
  workspaceId: ReadonlyRef<string>;
  enabled: ReadonlyRef<boolean>;
  refreshing: ReadonlyRef<boolean>;
  loadedCount: () => number;
  loadNextPage(): Promise<void>;
}

/** One scroll root owns pagination and keeps a visible row stable across catalog refreshes. */
export const useSidebarPagination = (options: SidebarPaginationOptions) => {
  const scroll = ref<HTMLElement>();
  const sentinel = ref<HTMLElement>();
  const expanded = ref(true);
  const anchorPadding = ref(0);
  const storageKey = computed(
    () =>
      `excalidraw:canvases-expanded:${options.owner() ?? ""}:${options.workspaceId.value}`,
  );
  let observer: IntersectionObserver | undefined;
  let request = false;
  let observation = 0;
  let anchors: { id: string; top: number }[] = [];
  const nearBottom = () => {
    const root = scroll.value;
    const end = sentinel.value;

    return (
      !!root &&
      !!end &&
      end.getBoundingClientRect().top <=
        root.getBoundingClientRect().bottom + 160
    );
  };
  const load = async () => {
    if (request || !options.enabled.value || !expanded.value || !nearBottom()) {
      return;
    }

    request = true;
    try {
      await options.loadNextPage();
    } finally {
      request = false;
    }

    await nextTick();
    if (options.enabled.value && nearBottom()) {
      void load();
    }
  };
  const toggle = () => {
    expanded.value = !expanded.value;
    if (!expanded.value) {
      anchorPadding.value = 0;
    }

    try {
      localStorage.setItem(storageKey.value, String(expanded.value));
    } catch (cause) {
      console.warn("无法保存画布分组显示设置", cause);
    }
  };
  const captureAnchor = () => {
    const root = scroll.value;

    if (!root) {
      return;
    }

    const top = root.getBoundingClientRect().top;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-canvas-id]")];
    const first = rows.findIndex(
      (row) => row.getBoundingClientRect().bottom > top,
    );
    const ordered = rows
      .map((row, index) => ({
        row,
        distance: Math.abs(index - Math.max(0, first)),
      }))
      .sort((a, b) => a.distance - b.distance)
      .map(({ row }) => row);

    anchors = ordered.map((row) => ({
      id: row.dataset.canvasId!,
      top: row.getBoundingClientRect().top,
    }));
  };
  const restoreAnchor = async () => {
    const context = storageKey.value;
    const captured = anchors;

    await nextTick();
    const root = scroll.value;
    const rows = [
      ...(root?.querySelectorAll<HTMLElement>("[data-canvas-id]") ?? []),
    ];
    const anchor = captured.find((entry) =>
      rows.some((row) => row.dataset.canvasId === entry.id),
    );
    const row = rows.find((entry) => entry.dataset.canvasId === anchor?.id);

    if (
      !root ||
      !row ||
      !anchor ||
      context !== storageKey.value ||
      !expanded.value
    ) {
      return;
    }

    const target =
      root.scrollTop + row.getBoundingClientRect().top - anchor.top;
    const shortage = Math.max(
      0,
      Math.ceil(target - (root.scrollHeight - root.clientHeight)),
    );

    // A refreshed prefix can move the anchor down without growing the loaded range.
    // Reserve only the missing scroll distance; the next appended page absorbs it.
    if (shortage) {
      anchorPadding.value += shortage;
      await nextTick();
    }

    if (
      root === scroll.value &&
      context === storageKey.value &&
      expanded.value
    ) {
      root.scrollTop = target;
    }

    if (anchors === captured) {
      anchors = [];
    }
  };
  const trimAnchorPadding = async () => {
    const context = storageKey.value;

    await nextTick();
    const root = scroll.value;

    if (
      !root ||
      !anchorPadding.value ||
      options.refreshing.value ||
      context !== storageKey.value
    ) {
      return;
    }

    const naturalMaximum =
      root.scrollHeight - root.clientHeight - anchorPadding.value;

    anchorPadding.value = Math.max(
      0,
      Math.ceil(root.scrollTop - naturalMaximum),
    );
  };

  watch(
    storageKey,
    () => {
      expanded.value = true;
      anchorPadding.value = 0;
      anchors = [];
      try {
        expanded.value = localStorage.getItem(storageKey.value) !== "false";
      } catch (cause) {
        console.warn("无法读取画布分组显示设置，默认展开", cause);
      }

      if (scroll.value) {
        scroll.value.scrollTop = 0;
      }
    },
    { immediate: true },
  );
  watch(
    options.loadedCount,
    (count, previous) => {
      if (count > previous && !options.refreshing.value) {
        void trimAnchorPadding();
      }
    },
    { flush: "sync" },
  );
  watch(scroll, (root) => {
    if (!root) {
      anchorPadding.value = 0;
    }
  });
  watch(
    options.refreshing,
    (refreshing) => {
      if (refreshing) {
        captureAnchor();
      } else {
        void restoreAnchor();
      }
    },
    { flush: "sync" },
  );
  watch(
    [scroll, sentinel, options.enabled, expanded],
    async () => {
      const generation = ++observation;

      observer?.disconnect();
      await nextTick();
      if (
        generation !== observation ||
        !scroll.value ||
        !sentinel.value ||
        !options.enabled.value ||
        !expanded.value
      ) {
        return;
      }

      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            void load();
          }
        },
        { root: scroll.value, rootMargin: "0px 0px 160px 0px" },
      );
      observer.observe(sentinel.value);
    },
    { flush: "post" },
  );
  onBeforeUnmount(() => {
    observation++;
    observer?.disconnect();
  });

  return { scroll, sentinel, expanded, anchorPadding, toggle };
};
