<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
} from "vue";
import type { DirectoryNode, NodeRef } from "#shared/directory-contracts";
import type { DirectoryTreeController } from "~/composables/use-directory-tree";
import { useDirectoryDrag } from "~/composables/use-directory-drag";
import { useDirectorySelection } from "~/composables/use-directory-selection";
import { nodeKey } from "~/lib/directory-api";
import QuietIcon from "~/components/QuietIcon.vue";
import DirectoryContextMenu from "~/components/DirectoryContextMenu.vue";
import MoveResourceDialog from "~/components/MoveResourceDialog.vue";

const props = defineProps<{
  tree: DirectoryTreeController;
  workspaceId: string;
  currentId?: string;
  ownerId: string;
}>();
const emit = defineEmits<{ dragging: [active: boolean]; recycle: [] }>();
const host = ref<HTMLElement>();
const rootExpanded = ref(true);
const anchorPadding = ref(0);
let anchors: { key: string; top: number }[] = [];
const favoritesExpanded = ref(true);
const editing = ref<{
  kind: NodeRef["kind"];
  parentId: string | null;
  item?: DirectoryNode;
  name: string;
}>();
const input = ref<HTMLInputElement>();
const submitting = ref(false);
const moving = ref<DirectoryNode>();
const movingBatch = ref<{
  sources: DirectoryNode[];
  revision: number;
  unconfirmed: boolean;
}>();
const menu = ref<{
  item: DirectoryNode;
  x: number;
  y: number;
  trigger: HTMLElement;
  favorite: boolean;
  batch: boolean;
}>();
const tree = props.tree;
const selection = useDirectorySelection(() =>
  rootExpanded.value
    ? rows.value.flatMap((row) =>
        row.type === "node" ? [nodeKey(row.item)] : [],
      )
    : [],
);
const selectionState = selection.state;
const selectedItems = computed(() =>
  selectionState.value.selectedKeys.flatMap((key) =>
    tree.known.value[key] ? [tree.known.value[key]!] : [],
  ),
);
const selectedCount = computed(() => selectedItems.value.length);
const hasSelection = (item: NodeRef) =>
  selectionState.value.selectedKeys.includes(nodeKey(item));
const clearWithEscape = (event: KeyboardEvent) => {
  if (
    tree.busy.value ||
    !host.value?.closest(".workspace-sidebar")?.contains(event.target as Node)
  )
    return false;
  const snapshot = selection.snapshot();

  if (snapshot.selectedKeys.length) {
    selection.restore({ ...snapshot, selectedKeys: [], anchor: undefined });

    return true;
  }

  if (!snapshot.explicitMode && !snapshot.anchor) return false;
  selection.clear();

  return true;
};
const { drag, box, start, startBlank, cancel, cancelPress, suppressClick } =
  useDirectoryDrag(tree, (active) => emit("dragging", active), {
    selection,
    host: () => host.value,
    selectedItems: () => selectedItems.value,
    deferEscape: () =>
      !!document.querySelector("dialog[open]") ||
      !!menu.value ||
      !!editing.value,
    clearWithEscape,
  });
const dragHint = ref<HTMLElement>();
const dragHintId = useId();
const dragHintPosition = ref({ left: 8, top: 8 });
const placeDragHint = async () => {
  await nextTick();
  const element = dragHint.value;
  const point = drag.value?.point;

  if (!element || !point) return;
  const viewport = window.visualViewport;
  const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
  const topEdge = (viewport?.offsetTop ?? 0) + 8;
  const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 16;
  const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 16;
  const bounds = element.getBoundingClientRect();
  const preferredTop =
    point.touch || point.y + 18 + bounds.height > bottomEdge
      ? point.y - bounds.height - 20
      : point.y + 18;
  const left = Math.max(
    leftEdge,
    Math.min(point.x + 14, rightEdge - bounds.width),
  );
  const top = Math.max(
    topEdge,
    Math.min(preferredTop, bottomEdge - bounds.height),
  );

  if (
    left !== dragHintPosition.value.left ||
    top !== dragHintPosition.value.top
  )
    dragHintPosition.value = { left, top };
};

watch(
  () => [drag.value?.reason, drag.value?.point],
  () => {
    void placeDragHint();
  },
  { flush: "post" },
);
const startRow = (
  event: PointerEvent,
  item: DirectoryNode,
  zone: "tree" | "favorites" = "tree",
) => {
  if (
    editing.value ||
    submitting.value ||
    movingBatch.value ||
    moving.value ||
    menu.value
  )
    return;
  if (zone === "favorites") selection.clear();
  start(event, item, zone);
};
const contextKey = computed(() => `${props.ownerId}:${props.workspaceId}`);
const branch = (id: string | null) => tree.branches.value[id ?? ""];
const storageKey = () => `excalidraw:directory-expanded:${contextKey.value}`;

type Row =
  | { type: "node"; item: DirectoryNode; level: number }
  | { type: "status"; parentId: string | null; level: number }
  | { type: "edit"; parentId: string | null; level: number };

const rows = computed(() => {
  const result: Row[] = [];
  const visit = (parentId: string | null, level: number) => {
    const page = branch(parentId)?.page;

    const creating =
      editing.value &&
      !editing.value.item &&
      editing.value.parentId === parentId;

    if (creating && editing.value?.kind === "canvas")
      result.push({ type: "edit", parentId, level });

    for (const item of page?.items ?? []) {
      result.push({ type: "node", item, level });
      if (item.kind === "folder" && tree.expanded.value.includes(item.id))
        visit(item.id, level + 1);
    }

    if (creating && editing.value?.kind === "folder")
      result.push({ type: "edit", parentId, level });
    result.push({ type: "status", parentId, level });
  };

  visit(null, 0);

  return result;
});
const clickRow = (
  event: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">,
  item: DirectoryNode,
  favorite = false,
) => {
  if (tree.busy.value || drag.value || box.value) return;
  if (favorite) {
    selection.clear();
    void tree.attempt(() =>
      item.kind === "folder" ? reveal(item) : tree.open(item),
    );

    return;
  }

  const additive = event.ctrlKey || event.metaKey;
  const intent = event.shiftKey
    ? additive
      ? "add-range"
      : "range"
    : additive || selectionState.value.explicitMode
      ? "toggle"
      : "plain";

  selection.click(nodeKey(item), intent);
  if (intent === "plain") void tree.attempt(() => tree.open(item));
};
const startBlankSelection = (event: PointerEvent) => {
  if (
    !editing.value &&
    !submitting.value &&
    !moving.value &&
    !movingBatch.value &&
    !menu.value
  )
    startBlank(event);
};
const beginBatchMove = () => {
  if (tree.locked.value || !selectedCount.value) return;
  tree.error.value = "";
  movingBatch.value = {
    sources: [...selectedItems.value],
    revision: tree.revision.value,
    unconfirmed: false,
  };
};
const removeSelected = async () => {
  const trigger = document.activeElement as HTMLElement | null;
  const context = contextKey.value;
  const sources = selectedItems.value.map(({ kind, id }) => ({ kind, id }));

  if (!sources.length) return;
  const outcome = await tree.removeMany(sources, tree.revision.value);

  if (context !== contextKey.value) return;
  if (outcome.kind === "applied") selection.clear();
  await nextTick();
  if (context !== contextKey.value) return;
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  else
    host.value
      ?.querySelector<HTMLElement>('[data-drop-zone="tree"] button')
      ?.focus({ preventScroll: true });
};
const chooseBatchDestination = async (parentId: string | null) => {
  const command = movingBatch.value;
  const context = contextKey.value;

  if (!command || command.unconfirmed) return;
  const outcome = await tree.moveMany({
    sources: command.sources.map(({ kind, id }) => ({ kind, id })),
    parentId,
    placement: "end",
    catalogRevision: command.revision,
  });

  if (context !== contextKey.value || movingBatch.value !== command) return;
  if (outcome.kind === "applied") {
    movingBatch.value = undefined;
    selection.clear();
  } else if (outcome.kind === "unconfirmed") command.unconfirmed = true;
};

watch(
  () => [
    rows.value,
    rootExpanded.value,
    tree.refreshing.value,
    tree.busy.value,
    tree.stale.value,
  ],
  () => {
    if (
      !tree.refreshing.value &&
      !tree.busy.value &&
      !tree.stale.value &&
      !box.value
    )
      selection.reconcile();
  },
  { deep: true, flush: "post" },
);
const menuScrollPositions = new Map<Element, { top: number; left: number }>();
const rememberMenuScroll = (trigger: HTMLElement) => {
  menuScrollPositions.clear();
  for (
    let element: Element | null = trigger;
    element;
    element = element.parentElement
  ) {
    menuScrollPositions.set(element, {
      top: element.scrollTop,
      left: element.scrollLeft,
    });
  }
};
const closeMenu = (restore = true) => {
  const trigger = menu.value?.trigger;

  menu.value = undefined;
  menuScrollPositions.clear();
  if (restore && trigger?.isConnected) trigger.focus({ preventScroll: true });
};
const openMenu = (
  event: MouseEvent | KeyboardEvent,
  item: DirectoryNode,
  favorite = false,
) => {
  event.preventDefault();
  event.stopPropagation();
  if (
    tree.locked.value ||
    editing.value ||
    (event.type === "contextmenu" &&
      (event as PointerEvent).pointerType === "touch")
  )
    return;
  const batch = !favorite && hasSelection(item);

  if (!batch) selection.clear();
  const element = event.currentTarget as HTMLElement;
  const trigger = element.matches("button")
    ? element
    : (element.querySelector<HTMLElement>(".directory-name") ?? element);
  const bounds = trigger.getBoundingClientRect();
  const keyboard = event instanceof KeyboardEvent || event.type === "click";

  rememberMenuScroll(trigger);
  menu.value = {
    item,
    x: keyboard ? bounds.left : event.clientX,
    y: keyboard ? bounds.bottom : event.clientY,
    trigger,
    favorite,
    batch,
  };
};
const onScroll = (event: Event) => {
  const element =
    event.target instanceof Element ? event.target : document.scrollingElement;

  if (element?.closest('[role="menu"]')) return;
  cancelPress();
  const previous = element && menuScrollPositions.get(element);

  // Focusing or clicking a row can queue a scroll event before the menu opens.
  // Only a position change since opening invalidates its fixed viewport anchor.
  if (
    element &&
    previous &&
    element.scrollTop === previous.top &&
    element.scrollLeft === previous.left
  )
    return;
  closeMenu(false);
};
const reveal = async (item: DirectoryNode) => {
  if (tree.locked.value) return;
  rootExpanded.value = true;
  await tree.attempt(() => tree.reveal(item));
};
const focusInput = async () => {
  await nextTick();
  input.value?.focus();
  input.value?.select();
};
const beginCreate = async (
  kind: NodeRef["kind"],
  parentId: string | null = null,
) => {
  if (tree.locked.value) return;
  selection.clear();
  rootExpanded.value = true;
  const parent = parentId ? tree.known.value[`folder:${parentId}`] : undefined;

  if (kind === "folder" && parent?.kind === "folder" && parent.depth >= 5)
    return;
  if (parent && !tree.expanded.value.includes(parent.id))
    await tree.toggle(parent);
  const now = new Date();

  editing.value = {
    kind,
    parentId,
    name:
      kind === "canvas"
        ? `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
        : "",
  };
  await focusInput();
};
const beginRename = async (item: DirectoryNode) => {
  await reveal(item);
  editing.value = {
    kind: item.kind,
    parentId: item.parentId,
    item,
    name: item.name,
  };
  await focusInput();
};
const saveName = async (event?: KeyboardEvent) => {
  if (event?.isComposing || event?.keyCode === 229 || submitting.value) return;
  event?.preventDefault();
  const value = editing.value;
  const name = value?.name.trim();

  if (!value || !name) {
    tree.error.value = "名称不能为空。";

    return;
  }

  submitting.value = true;
  const accepted = value.item
    ? await tree.rename(value.item, name)
    : await tree.create(value.kind, name, value.parentId);

  submitting.value = false;
  if (accepted) editing.value = undefined;
};
const cancelEditing = (event: KeyboardEvent) => {
  if (event.isComposing || submitting.value) return;
  editing.value = undefined;
};
const adjacent = async (
  item: DirectoryNode,
  offset: number,
  favorite = false,
) => {
  let items = favorite
    ? tree.favorites.value
    : (branch(item.parentId)?.page?.items ?? []);
  let index = items.findIndex((value) => nodeKey(value) === nodeKey(item));

  if (
    !favorite &&
    offset > 0 &&
    index === items.length - 1 &&
    branch(item.parentId)?.page?.nextCursor
  ) {
    await tree.load(item.parentId, true);
    items = branch(item.parentId)?.page?.items ?? [];
    index = items.findIndex((value) => nodeKey(value) === nodeKey(item));
  }

  const target = items[index + offset];

  if (!target) return;
  if (favorite)
    await tree.orderFavorite(item, target, offset < 0 ? "before" : "after");
  else
    await tree.move({
      source: item,
      parentId: item.parentId,
      target,
      placement: offset < 0 ? "before" : "after",
    });
};
const canMove = (offset: number) => {
  const target = menu.value;

  if (!target) return false;
  const items = target.favorite
    ? tree.favorites.value
    : (branch(target.item.parentId)?.page?.items ?? []);
  const index = items.findIndex(
    (item) => nodeKey(item) === nodeKey(target.item),
  );

  return (
    index >= 0 &&
    (!!items[index + offset] ||
      (!target.favorite &&
        offset > 0 &&
        !!branch(target.item.parentId)?.page?.nextCursor))
  );
};
const menuAction = (action: string) => {
  const target = menu.value;

  closeMenu();
  if (!target) return;
  const item = target.item;

  if (action === "select-multiple") {
    selection.enterExplicit(nodeKey(item));

    return;
  }

  if (target.batch) {
    if (action === "move") beginBatchMove();
    else if (action === "delete") void removeSelected();
    else if (action === "clear-selection") selection.clear();

    return;
  }

  void tree.attempt(async () => {
    if (action === "favorite") await tree.favorite(item);
    else if (action === "rename") await beginRename(item);
    else if (action === "delete") await tree.remove(item);
    else if (action === "move") moving.value = item;
    else if (action === "up" || action === "down")
      await adjacent(item, action === "up" ? -1 : 1, target.favorite);
    else if (action === "create-canvas" || action === "create-folder")
      await beginCreate(
        action === "create-folder" ? "folder" : "canvas",
        item.id,
      );
    else if (action === "locate") await reveal(item);
  });
};
const chooseDestination = async (parentId: string | null) => {
  if (!moving.value) return;
  const accepted = await tree.move({
    source: moving.value,
    parentId,
    placement: "end",
  });

  if (accepted) moving.value = undefined;
};
const chooseRestoreDestination = async (parentId: string | null) => {
  await tree.restore(parentId);
};
const key = (event: KeyboardEvent, item: DirectoryNode, favorite = false) => {
  if (
    !favorite &&
    (event.key === " " ||
      (event.key === "Enter" &&
        (event.ctrlKey || event.metaKey || event.shiftKey)))
  ) {
    event.preventDefault();
    clickRow(event, item);

    return;
  }

  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    openMenu(event, item, favorite);

    return;
  }

  const buttons = [
    ...(host.value?.querySelectorAll<HTMLButtonElement>(
      favorite ? "[data-favorite-name]" : "[data-tree-name]",
    ) ?? []),
  ];
  const index = buttons.indexOf(event.currentTarget as HTMLButtonElement);

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    buttons[
      Math.max(
        0,
        Math.min(
          buttons.length - 1,
          index + (event.key === "ArrowDown" ? 1 : -1),
        ),
      )
    ]?.focus();
  } else if (
    event.key === "ArrowRight" &&
    !favorite &&
    item.kind === "folder" &&
    !tree.expanded.value.includes(item.id)
  ) {
    event.preventDefault();
    void tree.toggle(item);
  } else if (event.key === "ArrowLeft" && !favorite) {
    event.preventDefault();
    if (item.kind === "folder" && tree.expanded.value.includes(item.id))
      void tree.toggle(item);
    else
      buttons
        .find((button) => button.dataset.treeName === `folder:${item.parentId}`)
        ?.focus();
  }

  event.stopPropagation();
};
const dropClass = (item?: DirectoryNode, zone = "tree") => {
  const drop = drag.value?.drop;

  if (!drop || drop.zone !== zone) return "";
  if (!item) return !drop.target && drop.parentId === null ? "drop-inside" : "";
  if (drop.target && nodeKey(drop.target) === nodeKey(item))
    return `drop-${drop.placement}`;

  return !drop.target && drop.parentId === item.id && item.kind === "folder"
    ? "drop-inside"
    : "";
};
const toggleRoot = () => {
  rootExpanded.value = !rootExpanded.value;
  try {
    localStorage.setItem(storageKey(), String(rootExpanded.value));
  } catch (cause) {
    console.warn("无法保存目录展开状态", cause);
  }
};
let observer: IntersectionObserver | undefined;
const observe = async () => {
  observer?.disconnect();
  await nextTick();
  if (
    !host.value ||
    drag.value ||
    box.value ||
    tree.busy.value ||
    tree.stale.value ||
    editing.value
  )
    return;
  const root = host.value.closest<HTMLElement>(".sidebar-scroll");

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const element = entry.target as HTMLElement;
        const parentId = element.dataset.directoryMore || null;

        if (!branch(parentId)?.error) void tree.load(parentId, true);
      }
    },
    { root, rootMargin: "0px 0px 160px 0px" },
  );
  for (const sentinel of host.value.querySelectorAll<HTMLElement>(
    "[data-directory-more]",
  ))
    observer.observe(sentinel);
};
const locate = async () => {
  await nextTick();
  if (menu.value || !rootExpanded.value) return;
  const item = [
    ...(host.value?.querySelectorAll<HTMLElement>("[data-tree-name]") ?? []),
  ].find((element) => element.dataset.treeName === tree.located.value);

  item?.scrollIntoView({ block: "nearest" });
};

watch(
  contextKey,
  () => {
    cancel();
    cancelPress();
    closeMenu(false);
    editing.value = undefined;
    moving.value = undefined;
    movingBatch.value = undefined;
    selection.clear();
    anchorPadding.value = 0;
    anchors = [];
    rootExpanded.value = true;
    try {
      rootExpanded.value = localStorage.getItem(storageKey()) !== "false";
    } catch (cause) {
      console.warn("无法读取目录展开状态", cause);
    }
  },
  { immediate: true },
);
watch(
  () => tree.locateVersion.value,
  () => {
    if (tree.locateExpandRoot.value) rootExpanded.value = true;
    if (!menu.value && rootExpanded.value) void locate();
  },
  { flush: "post" },
);
watch(
  () => [
    tree.branches.value,
    tree.expanded.value,
    rootExpanded.value,
    drag.value,
    box.value,
    tree.busy.value,
    tree.stale.value,
    editing.value,
  ],
  () => {
    void observe();
  },
  { deep: true, flush: "post" },
);
const captureAnchor = () => {
  const root = host.value?.closest<HTMLElement>(".sidebar-scroll");

  if (!root) return;
  const top = root.getBoundingClientRect().top;
  const nodes = [
    ...(host.value?.querySelectorAll<HTMLElement>("[data-node-id]") ?? []),
  ];
  const first = Math.max(
    0,
    nodes.findIndex((node) => node.getBoundingClientRect().bottom > top),
  );

  anchors = nodes
    .map((node, index) => ({
      key: node.dataset.directoryKey!,
      top: node.getBoundingClientRect().top,
      distance: Math.abs(index - first),
    }))
    .sort((a, b) => a.distance - b.distance);
};
const restoreAnchor = async () => {
  const context = contextKey.value;
  const captured = anchors;

  await nextTick();
  const root = host.value?.closest<HTMLElement>(".sidebar-scroll");
  const nodes = [
    ...(host.value?.querySelectorAll<HTMLElement>("[data-node-id]") ?? []),
  ];
  const anchor = captured.find((entry) =>
    nodes.some((node) => node.dataset.directoryKey === entry.key),
  );
  const node = nodes.find(
    (entry) => entry.dataset.directoryKey === anchor?.key,
  );

  if (
    context !== contextKey.value ||
    !root ||
    !node ||
    !anchor ||
    !rootExpanded.value
  )
    return;
  const target = root.scrollTop + node.getBoundingClientRect().top - anchor.top;
  const shortage = Math.max(
    0,
    Math.ceil(target - (root.scrollHeight - root.clientHeight)),
  );

  // Reordering an unloaded item into a loaded prefix can shift the anchor while
  // keeping the same total height. Reserve only what scrollTop would clamp away.
  if (shortage) {
    anchorPadding.value += shortage;
    await nextTick();
  }

  if (
    context === contextKey.value &&
    rootExpanded.value &&
    root === host.value?.closest(".sidebar-scroll")
  )
    root.scrollTop = target;
  if (anchors === captured) anchors = [];
};
const trimAnchorPadding = async () => {
  const context = contextKey.value;

  await nextTick();
  const root = host.value?.closest<HTMLElement>(".sidebar-scroll");

  if (
    !root ||
    !anchorPadding.value ||
    tree.busy.value ||
    tree.refreshing.value ||
    context !== contextKey.value
  )
    return;
  const naturalMaximum =
    root.scrollHeight - root.clientHeight - anchorPadding.value;

  anchorPadding.value = Math.max(0, Math.ceil(root.scrollTop - naturalMaximum));
};

watch(
  () => rows.value.filter((row) => row.type === "node").length,
  (count, previous) => {
    if (count > previous && !tree.refreshing.value) void trimAnchorPadding();
  },
  { flush: "sync" },
);
watch(rootExpanded, (expanded) => {
  if (!expanded) {
    anchorPadding.value = 0;
    anchors = [];
  }
});

watch(
  () => tree.busy.value || tree.refreshing.value,
  (active) => {
    if (active) captureAnchor();
    else void restoreAnchor();
  },
  { flush: "sync" },
);
defineExpose({ beginCreate, clearSelection: selection.clear });
onMounted(() => {
  void observe();
  if (rootExpanded.value) void locate();
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", placeDragHint);
  window.visualViewport?.addEventListener("resize", placeDragHint);
  window.visualViewport?.addEventListener("scroll", placeDragHint);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  cancelPress();
  closeMenu(false);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", placeDragHint);
  window.visualViewport?.removeEventListener("resize", placeDragHint);
  window.visualViewport?.removeEventListener("scroll", placeDragHint);
});
</script>

<template>
  <section
    ref="host"
    class="resource-tree"
    tabindex="-1"
    aria-label="空间文件管理"
    @pointerdown="startBlankSelection"
    @click.capture="suppressClick"
  >
    <div
      v-if="tree.favorites.value.length"
      class="section-heading"
      data-drop-zone="favorites"
      :class="dropClass(undefined, 'favorites')"
    >
      <button
        type="button"
        :aria-expanded="favoritesExpanded"
        aria-controls="favorite-list"
        :disabled="!!drag"
        @click="favoritesExpanded = !favoritesExpanded"
      >
        <QuietIcon
          name="chevron"
          :size="12"
          :class="{ expanded: favoritesExpanded }"
        /><span>收藏</span><small>{{ tree.favorites.value.length }}</small>
      </button>
    </div>
    <ul
      v-if="favoritesExpanded && tree.favorites.value.length"
      id="favorite-list"
      data-favorite-list
      class="resource-list"
      aria-label="收藏"
    >
      <li
        v-for="item in tree.favorites.value"
        :key="nodeKey(item)"
        :data-directory-key="nodeKey(item)"
        :class="dropClass(item, 'favorites')"
        @contextmenu="openMenu($event, item, true)"
        @pointerdown="startRow($event, item, 'favorites')"
      >
        <button
          type="button"
          class="directory-name"
          :title="item.name"
          :data-favorite-name="nodeKey(item)"
          :aria-describedby="
            drag?.reason &&
            drag.zone === 'favorites' &&
            nodeKey(drag.item) === nodeKey(item)
              ? dragHintId
              : undefined
          "
          :disabled="tree.busy.value"
          :aria-disabled="tree.busy.value || !!drag"
          @keydown="key($event, item, true)"
          @click="clickRow($event, item, true)"
        >
          <span data-node-icon :data-icon-kind="item.kind" class="node-icon"
            ><QuietIcon
              :name="item.kind === 'folder' ? 'folder' : 'canvas'"
              :size="15" /></span
          ><span>{{ item.name }}</span>
        </button>
        <button
          type="button"
          class="row-action"
          :aria-label="`收藏 ${item.name} 的操作`"
          @click.stop="openMenu($event, item, true)"
        >
          <svg
            data-sidebar-more-icon
            width="18"
            height="18"
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="currentColor"
          >
            <circle
              v-for="cx in [5, 12, 19]"
              :key="cx"
              :cx="cx"
              cy="12"
              r="1.65"
            />
          </svg>
        </button>
      </li>
    </ul>
    <div class="section-heading" data-drop-zone="tree" :class="dropClass()">
      <button
        type="button"
        :aria-expanded="rootExpanded"
        aria-controls="directory-list"
        :disabled="!!drag"
        @click="toggleRoot"
      >
        <QuietIcon
          name="chevron"
          :size="12"
          :class="{ expanded: rootExpanded }"
        /><span>我的文件</span
        ><small>{{ branch(null)?.page?.total ?? "" }}</small>
      </button>
      <span
        v-if="!tree.favorites.value.length && drag"
        class="empty-favorite-drop"
        data-drop-zone="favorites"
        aria-label="拖到此处收藏"
        :class="dropClass(undefined, 'favorites')"
        >收藏</span
      >
      <button
        type="button"
        :disabled="tree.locked.value || !workspaceId"
        aria-label="新建文件夹"
        title="新建文件夹"
        @click="beginCreate('folder')"
      >
        <QuietIcon name="folder" :size="15" />
      </button>
      <button
        type="button"
        :disabled="tree.locked.value || !workspaceId"
        aria-label="新建画布"
        title="新建画布"
        @click="beginCreate('canvas')"
      >
        <QuietIcon name="plus" :size="16" />
      </button>
    </div>
    <ul
      v-if="rootExpanded"
      id="directory-list"
      class="resource-list"
      aria-label="我的文件"
    >
      <template
        v-for="row in rows"
        :key="
          row.type === 'node'
            ? nodeKey(row.item)
            : `${row.type}:${row.parentId}`
        "
      >
        <li
          v-if="row.type === 'node'"
          :data-node-kind="row.item.kind"
          :data-node-id="row.item.id"
          :data-directory-key="nodeKey(row.item)"
          :data-canvas-id="row.item.kind === 'canvas' ? row.item.id : undefined"
          :data-folder-id="row.item.kind === 'folder' ? row.item.id : undefined"
          :class="[
            dropClass(row.item),
            {
              selected: row.item.kind === 'canvas' && currentId === row.item.id,
              located: tree.located.value === nodeKey(row.item),
              'batch-selected': hasSelection(row.item),
              dragging:
                drag &&
                drag.items.some((item) => nodeKey(item) === nodeKey(row.item)),
            },
          ]"
          :style="{ paddingLeft: `${row.level * 14}px` }"
          @contextmenu="openMenu($event, row.item)"
          @pointerdown="startRow($event, row.item)"
        >
          <form
            v-if="editing?.item && nodeKey(editing.item) === nodeKey(row.item)"
            class="inline-name"
            @submit.prevent="saveName()"
          >
            <input
              :ref="(element) => (input = element as HTMLInputElement)"
              v-model="editing.name"
              :disabled="submitting"
              :aria-label="`重命名${row.item.kind === 'folder' ? '文件夹' : '画布'}名称`"
              maxlength="120"
              @keydown.enter.stop="saveName($event)"
              @keydown.esc.prevent.stop="cancelEditing"
              @keydown.stop
              @keyup.stop
            />
            <button type="submit" :disabled="submitting" aria-label="确认名称">
              <QuietIcon name="check" :size="14" /></button
            ><button
              type="button"
              :disabled="submitting"
              aria-label="取消编辑名称"
              @click="editing = undefined"
            >
              <QuietIcon name="close" :size="14" />
            </button>
          </form>
          <template v-else>
            <input
              v-if="selectionState.explicitMode"
              class="selection-checkbox"
              type="checkbox"
              :checked="hasSelection(row.item)"
              :disabled="tree.locked.value"
              :aria-label="`选择 ${row.item.name}`"
              @click.stop="selection.click(nodeKey(row.item), 'toggle')"
            />
            <button
              v-if="selectionState.explicitMode && row.item.kind === 'folder'"
              class="selection-expand"
              type="button"
              :disabled="tree.locked.value"
              :aria-label="`${tree.expanded.value.includes(row.item.id) ? '收起' : '展开'}文件夹 ${row.item.name}`"
              :aria-expanded="tree.expanded.value.includes(row.item.id)"
              @click.stop="tree.toggle(row.item)"
            >
              <QuietIcon
                name="chevron"
                :size="13"
                :class="{ expanded: tree.expanded.value.includes(row.item.id) }"
              />
            </button>
            <button
              type="button"
              class="directory-name canvas-name"
              :data-tree-name="nodeKey(row.item)"
              :aria-describedby="
                drag?.reason &&
                drag.zone === 'tree' &&
                nodeKey(drag.item) === nodeKey(row.item)
                  ? dragHintId
                  : undefined
              "
              :aria-expanded="
                row.item.kind === 'folder'
                  ? tree.expanded.value.includes(row.item.id)
                  : undefined
              "
              :aria-current="
                row.item.kind === 'canvas' && currentId === row.item.id
                  ? 'page'
                  : undefined
              "
              :aria-label="row.item.name"
              :title="row.item.name"
              :disabled="tree.busy.value"
              :aria-disabled="tree.busy.value || !!drag"
              :aria-pressed="hasSelection(row.item)"
              @click="clickRow($event, row.item)"
              @keydown="key($event, row.item)"
            >
              <span
                data-node-icon
                :data-icon-kind="row.item.kind"
                class="node-icon"
              >
                <QuietIcon
                  :name="row.item.kind === 'folder' ? 'folder' : 'canvas'"
                  :size="15"
                  :class="{ 'folder-symbol': row.item.kind === 'folder' }"
                />
                <QuietIcon
                  v-if="row.item.kind === 'folder'"
                  class="folder-chevron"
                  name="chevron"
                  :size="15"
                  :class="{
                    expanded: tree.expanded.value.includes(row.item.id),
                  }"
                /> </span
              ><span>{{ row.item.name }}</span>
            </button>

            <button
              type="button"
              class="row-action"
              :disabled="tree.locked.value"
              :aria-label="`${row.item.kind === 'folder' ? '文件夹' : '画布'} ${row.item.name} 的操作`"
              @click.stop="openMenu($event, row.item)"
            >
              <svg
                data-sidebar-more-icon
                width="18"
                height="18"
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill="currentColor"
              >
                <circle
                  v-for="cx in [5, 12, 19]"
                  :key="cx"
                  :cx="cx"
                  cy="12"
                  r="1.65"
                />
              </svg>
            </button>
          </template>
        </li>
        <li
          v-else-if="row.type === 'edit' && editing"
          class="new-name"
          :style="{ paddingLeft: `${row.level * 14 + 16}px` }"
        >
          <QuietIcon
            :name="editing.kind === 'folder' ? 'folder' : 'canvas'"
            :size="15"
          />
          <form class="inline-name" @submit.prevent="saveName()">
            <input
              :ref="(element) => (input = element as HTMLInputElement)"
              v-model="editing.name"
              :disabled="submitting"
              :aria-label="`新建${editing.kind === 'folder' ? '文件夹' : '画布'}名称`"
              maxlength="120"
              @keydown.enter.stop="saveName($event)"
              @keydown.esc.prevent.stop="cancelEditing"
              @keydown.stop
              @keyup.stop
            /><button
              type="submit"
              :disabled="submitting"
              aria-label="确认名称"
            >
              <QuietIcon name="check" :size="14" /></button
            ><button
              type="button"
              :disabled="submitting"
              aria-label="取消编辑名称"
              @click="editing = undefined"
            >
              <QuietIcon name="close" :size="14" />
            </button>
          </form>
        </li>
        <li
          v-else-if="row.type === 'status'"
          class="branch-status"
          :style="{ paddingLeft: `${row.level * 14 + 12}px` }"
        >
          <button
            v-if="branch(row.parentId)?.page?.hasPrevious"
            type="button"
            :disabled="!!drag || !!box || tree.busy.value"
            @click="tree.load(row.parentId)"
          >
            显示前面的项目
          </button>
          <span v-if="branch(row.parentId)?.loading">正在加载…</span>
          <button
            v-else-if="branch(row.parentId)?.error"
            type="button"
            :disabled="!!drag || !!box || tree.busy.value"
            @click="tree.load(row.parentId, !!branch(row.parentId)?.page)"
          >
            加载失败，重试
          </button>
          <template v-else-if="branch(row.parentId)?.page?.nextCursor"
            ><button
              type="button"
              :disabled="!!drag || !!box || tree.busy.value"
              @click="tree.load(row.parentId, true)"
            >
              加载更多项目</button
            ><span
              :data-directory-more="row.parentId ?? ''"
              class="branch-sentinel"
              aria-hidden="true"
          /></template>
          <span v-else-if="branch(row.parentId)?.page?.total === 0">{{
            row.parentId ? "空文件夹" : "这个空间还没有文件"
          }}</span>
        </li>
      </template>
    </ul>
    <Teleport to="body">
      <Transition name="directory-drag-hint">
        <div
          v-if="drag?.reason"
          :id="dragHintId"
          ref="dragHint"
          class="directory-drag-tooltip"
          data-directory-drag-tooltip
          role="tooltip"
          aria-live="polite"
          :style="{
            left: `${dragHintPosition.left}px`,
            top: `${dragHintPosition.top}px`,
          }"
        >
          {{ drag.reason }}
        </div>
      </Transition>
    </Teleport>
    <Teleport to="body">
      <div
        v-if="box"
        class="directory-selection-box"
        data-directory-selection-box
        aria-hidden="true"
        :style="{
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${Math.max(0, box.right - box.left)}px`,
          height: `${Math.max(0, box.bottom - box.top)}px`,
        }"
      />
    </Teleport>
    <Teleport to="#directory-status" defer>
      <div
        v-if="selectedCount || selectionState.explicitMode"
        class="selection-actions"
        aria-label="所选资源操作"
      >
        <span role="status">已选 {{ selectedCount }} 项</span>
        <button
          type="button"
          :disabled="tree.locked.value || !selectedCount"
          @click="beginBatchMove"
        >
          移动到…
        </button>
        <button
          type="button"
          :disabled="tree.locked.value || !selectedCount"
          @click="removeSelected"
        >
          移入回收站
        </button>
        <button
          type="button"
          :disabled="tree.busy.value"
          @click="selection.clear()"
        >
          {{ selectionState.explicitMode ? "退出多选" : "取消选择" }}
        </button>
      </div>
      <div v-if="tree.batchNotice.value" class="undo-notice" role="status">
        <span>{{ tree.batchNotice.value }}</span>
        <button
          v-if="tree.batchUndo.value"
          type="button"
          :disabled="!tree.batchUndoAvailable.value"
          @click="tree.undoBatch()"
        >
          {{ tree.batchUndo.value.kind === "move" ? "撤销移动" : "撤销删除" }}
        </button>
        <button
          v-if="tree.batchUndo.value?.kind === 'delete'"
          type="button"
          @click="emit('recycle')"
        >
          回收站
        </button>
      </div>
      <div
        v-if="tree.error.value || tree.stale.value"
        class="tree-error"
        role="alert"
      >
        <span>{{ tree.error.value || "目录已更新，请重新加载。" }}</span
        ><button
          type="button"
          :disabled="tree.busy.value"
          @click="tree.attempt(tree.refresh)"
        >
          重新加载目录
        </button>
      </div>
      <div v-if="tree.undo.value" class="undo-notice" role="status">
        <span>已移入回收站</span
        ><button
          type="button"
          :disabled="tree.locked.value"
          @click="tree.attempt(tree.restore)"
        >
          撤销删除</button
        ><button type="button" @click="emit('recycle')">回收站</button>
      </div>
    </Teleport>
    <div
      v-if="anchorPadding"
      class="scroll-anchor-spacer"
      :style="{ height: `${anchorPadding}px` }"
      aria-hidden="true"
    />
    <MoveResourceDialog
      v-if="tree.restoreLocationRequired.value && tree.undo.value"
      :workspace-id="workspaceId"
      :source="tree.undo.value"
      :name="tree.undo.value.name"
      :subtree-depth="
        tree.undo.value.kind === 'folder'
          ? tree.undo.value.subtreeDepth
          : undefined
      "
      restoring
      :busy="tree.busy.value"
      :error="tree.error.value"
      @close="tree.cancelRestoreLocation()"
      @choose="chooseRestoreDestination"
    />
    <DirectoryContextMenu
      v-if="menu"
      :item="menu.item"
      :x="menu.x"
      :y="menu.y"
      :locked="tree.locked.value"
      :favorite-context="menu.favorite"
      :selection-count="menu.batch ? selectedCount : undefined"
      :can-move-up="canMove(-1)"
      :can-move-down="canMove(1)"
      @close="closeMenu()"
      @action="menuAction"
    />
    <MoveResourceDialog
      v-if="movingBatch"
      :workspace-id="workspaceId"
      :sources="movingBatch.sources"
      :catalog-revision="movingBatch.revision"
      :name="`所选 ${movingBatch.sources.length} 项`"
      :busy="tree.busy.value"
      :blocked="movingBatch.unconfirmed"
      :error="tree.error.value"
      @close="movingBatch = undefined"
      @choose="chooseBatchDestination"
    />
    <MoveResourceDialog
      v-if="moving"
      :workspace-id="workspaceId"
      :source="moving"
      :name="moving.name"
      :subtree-depth="
        moving.kind === 'folder' ? moving.subtreeDepth : undefined
      "
      :busy="tree.busy.value"
      :error="tree.error.value"
      @close="moving = undefined"
      @choose="chooseDestination"
    />
  </section>
</template>

<style scoped>
.directory-drag-tooltip {
  position: fixed;
  z-index: 1300;
  box-sizing: border-box;
  max-width: min(280px, calc(100vw - 16px));
  max-height: calc(100dvh - 16px);
  padding: 7px 10px;
  overflow: hidden;
  overflow-wrap: anywhere;
  pointer-events: none;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface);
  color: var(--app-text);
  box-shadow: 0 4px 16px var(--app-shadow);
  font-size: 12px;
  line-height: 1.5;
}
.directory-drag-hint-enter-active,
.directory-drag-hint-leave-active {
  transition: opacity 140ms ease-out;
}
.directory-drag-hint-enter-from,
.directory-drag-hint-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .directory-drag-hint-enter-active,
  .directory-drag-hint-leave-active {
    transition: none;
  }
}
.resource-tree {
  position: relative;
  flex: 1 0 auto;
  padding: 0 0 28px;
  color: var(--app-muted);
  outline: none;
}
.directory-selection-box {
  position: fixed;
  z-index: 1200;
  pointer-events: none;
  border: 1px solid var(--app-muted);
  background: color-mix(in srgb, var(--app-muted) 14%, transparent);
  box-sizing: border-box;
}
.resource-tree .resource-list > li.batch-selected {
  background: color-mix(in srgb, var(--app-muted) 24%, var(--app-surface));
}
.selection-checkbox {
  flex: none;
  margin: 0 4px;
  accent-color: var(--app-muted);
}
.selection-expand {
  flex: none;
  padding: 5px 2px;
  display: flex;
  align-items: center;
}
.selection-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px;
  font-size: 11px;
}
.selection-actions > span {
  flex-basis: 100%;
}
.selection-actions button {
  padding: 4px 6px;
  border: 1px solid var(--app-border);
}

button {
  font: inherit;
  color: inherit;
  cursor: pointer;
  border: 0;
  background: transparent;
  border-radius: 4px;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
button:hover {
  background: var(--app-hover);
}
button:focus-visible {
  outline: 2px solid var(--app-focus);
  outline-offset: -2px;
}
.section-heading {
  display: flex;
  align-items: center;
  min-height: 32px;
  gap: 2px;
  margin-top: 8px;
  padding-inline: 5px;
  border-radius: 5px;
}
.section-heading > button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  font-size: 12px;
}
.empty-favorite-drop {
  flex: none;
  align-self: center;
  padding: 4px 6px;
  border: 1px dashed var(--app-border);
  border-radius: 4px;
  font-size: 10px;
  line-height: 16px;
  white-space: nowrap;
}
.section-heading > button:first-child {
  flex: 1;
  min-width: 0;
  text-align: left;
}
small {
  font-size: 10px;
  color: var(--app-subtle);
}
.expanded {
  transform: rotate(90deg);
}
.resource-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.resource-list > li {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 32px;
  border-radius: 5px;
  padding-right: 3px;
  touch-action: pan-y;
  user-select: none;
}
.resource-list > li:hover,
.resource-list > li:focus-within {
  background: var(--app-hover);
}
.resource-list > li.selected {
  color: var(--app-selected-text);
  background: var(--app-selected);
}
.directory-name {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  gap: 6px;
  padding: 7px 4px;
  font-size: 13px;
  text-align: left;
}
.directory-name span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.directory-name svg {
  flex: none;
}
.node-icon {
  color: var(--app-muted);
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 15px;
  height: 15px;
  flex: none;
}
.node-icon > svg {
  grid-area: 1 / 1;
}
.node-icon .folder-chevron {
  display: none;
}
@media (hover: hover) and (pointer: fine) {
  li:hover .node-icon .folder-symbol,
  .canvas-name:focus-visible .node-icon .folder-symbol {
    display: none;
  }
  li:hover .node-icon .folder-chevron,
  .canvas-name:focus-visible .node-icon .folder-chevron {
    display: block;
  }
}
.row-action {
  display: flex;
  color: var(--app-muted);
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 28px;
  padding: 2px;
  opacity: 0;
}
li:hover .row-action,
li:focus-within .row-action {
  opacity: 1;
}
.dragging {
  opacity: 0.5;
}
.drop-inside {
  background: var(--app-selected) !important;
  box-shadow: inset 0 0 0 1px var(--app-focus) !important;
}
.drop-before::before,
.drop-after::after {
  content: "";
  position: absolute;
  left: 8px;
  right: 0;
  height: 2px;
  background: var(--app-focus);
  z-index: 1;
  pointer-events: none;
}
.drop-before::before {
  top: -3px;
}
.drop-after::after {
  bottom: -3px;
}
.inline-name {
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
  gap: 2px;
}
.inline-name input {
  width: 0;
  flex: 1;
  min-width: 24px;
  padding: 5px;
  border: 1px solid var(--app-focus);
  border-radius: 4px;
  font: inherit;
  font-size: 13px;
  color: var(--app-text);
  background: var(--app-surface);
}
.inline-name button {
  display: flex;
  padding: 5px 3px;
}
.branch-status {
  display: flex;
  flex-direction: column;
  align-items: stretch !important;
  min-height: 0 !important;
  font-size: 11px;
}
.branch-status span:not(.branch-sentinel),
.branch-status button {
  padding: 6px;
  text-align: left;
}
.branch-sentinel {
  height: 1px;
  width: 100%;
}
.empty {
  font-size: 11px;
  padding: 8px 12px;
}
.tree-error,
.undo-notice {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.tree-error {
  color: var(--app-danger);
}
.tree-error button,
.undo-notice button {
  text-decoration: underline;
}
@media (hover: none), (pointer: coarse), (max-width: 760px) {
  .row-action {
    opacity: 1;
  }
  .row-action {
    width: 28px;
    min-height: 32px;
  }
}
</style>
