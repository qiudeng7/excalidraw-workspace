import { onBeforeUnmount, onMounted, ref, shallowReadonly } from "vue";
import type { DirectoryNode, NodeRef } from "#shared/directory-contracts";
import type { DirectoryTreeController } from "~/composables/use-directory-tree";
import { nodeKey } from "~/lib/directory-api";
import type {
  DirectorySelectionController,
  DirectorySelectionSnapshot,
  DirectoryBoxMode,
} from "~/composables/use-directory-selection";
import {
  directoryAutoScrollDelta,
  directorySelectionRect,
  hitDirectorySelectionRows,
  toDirectoryContentPoint,
} from "~/lib/directory-selection-geometry";
import type {
  DirectorySelectionPoint,
  DirectorySelectionRect,
} from "~/lib/directory-selection-geometry";

export interface DirectoryDrop {
  zone: "tree" | "favorites";
  parentId: string | null;
  target?: NodeRef;
  placement: "before" | "after" | "end";
}

type DragZone = DirectoryDrop["zone"];

interface RowPress {
  item: DirectoryNode;
  zone: DragZone;
  element: HTMLElement;
  pointerId: number;
  pointerType: string;
  x: number;
  y: number;
  modified: boolean;
}

interface BlankPress {
  element: HTMLElement;
  pointerId: number;
  x: number;
  y: number;
  start: DirectorySelectionPoint;
  base: DirectorySelectionSnapshot;
  mode: DirectoryBoxMode;
  active: boolean;
}

export interface DirectoryGestureOptions {
  selection: DirectorySelectionController;
  host(): HTMLElement | undefined;
  selectedItems(): DirectoryNode[];
  deferEscape(): boolean;
  clearWithEscape(event: KeyboardEvent): boolean;
}

/** 整行手势只生成目录意图；轻触、滚动和拖动分别结束，不接管编辑器。 */
export const useDirectoryDrag = (
  tree: DirectoryTreeController,
  changed: (active: boolean) => void,
  options: DirectoryGestureOptions,
) => {
  const box = ref<DirectorySelectionRect>();
  let blank: BlankPress | undefined;
  const drag = ref<{
    item: DirectoryNode;
    items: DirectoryNode[];
    batch: boolean;
    catalogRevision: number;
    zone: DragZone;
    drop?: DirectoryDrop;
    reason?: string;
    point: { x: number; y: number; touch: boolean };
  }>();
  let pending: RowPress | undefined;
  let active: RowPress | undefined;
  let root: HTMLElement | null = null;
  let x = 0;
  let y = 0;
  let frame = 0;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let hover: ReturnType<typeof setTimeout> | undefined;
  let hoverId = "";
  let suppressNextClick = false;
  const clearHover = () => {
    clearTimeout(hover);
    hover = undefined;
    hoverId = "";
  };
  const clearPress = () => {
    clearTimeout(hold);
    hold = undefined;
    pending = undefined;
  };
  const insideSource = (target: DirectoryNode) =>
    (drag.value?.items ?? []).some((source) => {
      if (source.kind !== "folder") return false;
      if (target.kind === "folder" && source.id === target.id) return true;
      let parent = target.parentId;

      while (parent) {
        if (parent === source.id) return true;
        parent = tree.known.value[`folder:${parent}`]?.parentId ?? null;
      }

      return false;
    });
  const rowAtGap = (element: Element) => {
    const list = element.closest<HTMLElement>(
      "#directory-list, [data-favorite-list]",
    );

    if (!list || element.closest(".branch-status")) return undefined;
    const rows = [
      ...list.querySelectorAll<HTMLElement>(":scope > [data-directory-key]"),
    ];
    const previous = [...rows]
      .reverse()
      .find((row) => row.getBoundingClientRect().bottom <= y);
    const following = rows.find((row) => row.getBoundingClientRect().top >= y);
    const beforeDistance = following
      ? following.getBoundingClientRect().top - y
      : Infinity;
    const afterDistance = previous
      ? y - previous.getBoundingClientRect().bottom
      : Infinity;

    if (Math.min(beforeDistance, afterDistance) > 4) return undefined;

    return beforeDistance <= afterDistance && following
      ? { element: following, placement: "before" as const }
      : previous
        ? { element: previous, placement: "after" as const }
        : undefined;
  };
  const targetAtPointer = () => {
    if (!drag.value) return;
    drag.value.point = { x, y, touch: active?.pointerType === "touch" };
    const hit = document.elementFromPoint(x, y);
    let element = hit?.closest<HTMLElement>(
      "[data-directory-key], [data-drop-zone]",
    );
    const gap = !element && hit ? rowAtGap(hit) : undefined;

    element ??= gap?.element;
    const zone: DragZone =
      element?.dataset.dropZone === "favorites" ||
      element?.closest("[data-favorite-list]")
        ? "favorites"
        : "tree";
    const item = element?.dataset.directoryKey
      ? tree.known.value[element.dataset.directoryKey]
      : undefined;

    drag.value.drop = undefined;
    drag.value.reason = undefined;
    if (!element) {
      clearHover();

      return;
    }

    if (zone === "favorites" && drag.value.items.length > 1) {
      drag.value.reason = "批量移动请放到我的文件";
      clearHover();

      return;
    }

    if (!item) {
      drag.value.drop = { zone, parentId: null, placement: "end" };
      clearHover();

      return;
    }

    if (
      drag.value.items.some((source) => nodeKey(source) === nodeKey(item)) ||
      (zone === "tree" && insideSource(item))
    ) {
      drag.value.reason = "不能移动到自身或自己的子文件夹";
      clearHover();

      return;
    }

    const bounds = element.getBoundingClientRect();
    const inside = !gap && zone === "tree" && item.kind === "folder";
    const sources = drag.value.items;
    const parent = inside
      ? item
      : item.parentId
        ? tree.known.value[`folder:${item.parentId}`]
        : undefined;

    if (
      zone === "tree" &&
      sources.some(
        (source) =>
          source.kind === "folder" &&
          (parent?.kind === "folder" ? parent.depth : 0) + source.subtreeDepth >
            5,
      )
    ) {
      drag.value.reason = "放入后文件夹将超过 5 层";
      clearHover();

      return;
    }

    drag.value.drop = {
      zone,
      parentId: inside ? item.id : item.parentId,
      target: inside ? undefined : { kind: item.kind, id: item.id },
      placement: inside
        ? "end"
        : (gap?.placement ??
          (y < bounds.top + bounds.height / 2 ? "before" : "after")),
    };
    if (!inside || tree.expanded.value.includes(item.id)) {
      clearHover();

      return;
    }

    if (hoverId === item.id) return;
    clearHover();
    hoverId = item.id;
    hover = setTimeout(() => {
      if (drag.value && hoverId === item.id)
        void tree.attempt(() => tree.toggle(item));
    }, 650);
  };
  const contentPoint = (point: DirectorySelectionPoint) => {
    const bounds = root!.getBoundingClientRect();

    return toDirectoryContentPoint(point, {
      left: bounds.left,
      top: bounds.top,
      scrollLeft: root!.scrollLeft,
      scrollTop: root!.scrollTop,
    });
  };
  const updateBox = () => {
    if (!blank?.active || !root) return;
    const rect = directorySelectionRect(blank.start, contentPoint({ x, y }));
    const rows = [
      ...(options.host()?.querySelectorAll<HTMLElement>("[data-node-id]") ??
        []),
    ].map((element) => {
      const bounds = element.getBoundingClientRect();

      return {
        key: element.dataset.directoryKey!,
        rect: directorySelectionRect(
          contentPoint({ x: bounds.left, y: bounds.top }),
          contentPoint({ x: bounds.right, y: bounds.bottom }),
        ),
      };
    });

    options.selection.applyBox(
      hitDirectorySelectionRows(rect, rows),
      blank.base,
      blank.mode,
    );
    const bounds = root.getBoundingClientRect();

    box.value = {
      left: Math.max(bounds.left, rect.left + bounds.left - root.scrollLeft),
      top: Math.max(bounds.top, rect.top + bounds.top - root.scrollTop),
      right: Math.min(bounds.right, rect.right + bounds.left - root.scrollLeft),
      bottom: Math.min(
        bounds.bottom,
        rect.bottom + bounds.top - root.scrollTop,
      ),
    };
  };
  const scroll = () => {
    if (!drag.value && !blank?.active) return;
    if (root) {
      const bounds = root.getBoundingClientRect();
      const delta = directoryAutoScrollDelta(y, bounds.top, bounds.bottom);

      if (delta) root.scrollTop += delta;
    }

    if (blank?.active) updateBox();
    else targetAtPointer();
    frame = requestAnimationFrame(scroll);
  };
  const endBox = (restore: boolean) => {
    const previous = blank;

    if (!previous) return;
    blank = undefined;
    box.value = undefined;
    if (restore) options.selection.restore(previous.base);
    if (previous.active) {
      suppressNextClick = true;
      changed(false);
    }

    if (previous.element.hasPointerCapture(previous.pointerId))
      previous.element.releasePointerCapture(previous.pointerId);
    cancelAnimationFrame(frame);
    root = null;
  };
  const cancel = () => {
    const previous = active;
    const consumed = !!(active || pending || blank);

    endBox(true);

    if (drag.value) suppressNextClick = true;
    clearPress();
    active = undefined;
    drag.value = undefined;
    root = null;
    cancelAnimationFrame(frame);
    clearHover();
    if (previous?.element.hasPointerCapture(previous.pointerId))
      previous.element.releasePointerCapture(previous.pointerId);
    if (previous) changed(false);

    return consumed;
  };
  const activate = (press: RowPress) => {
    if (tree.locked.value || !press.element.isConnected) {
      clearPress();

      return;
    }

    clearPress();
    active = press;
    root = press.element.closest<HTMLElement>(".sidebar-scroll");
    // Touch uses its native touchmove/end stream so pan-y remains available
    // before the hold, without losing the drag to the browser's pointercancel.
    if (press.pointerType !== "touch")
      press.element.setPointerCapture(press.pointerId);
    const selected = options.selectedItems();
    const batch =
      press.zone === "tree" &&
      selected.some((item) => nodeKey(item) === nodeKey(press.item));

    if (!batch) options.selection.clear();
    drag.value = {
      item: press.item,
      items: batch ? selected : [press.item],
      batch,
      catalogRevision: tree.revision.value,
      zone: press.zone,
      point: { x, y, touch: press.pointerType === "touch" },
    };
    suppressNextClick = true;
    changed(true);
    frame = requestAnimationFrame(scroll);
  };
  const start = (
    event: PointerEvent,
    item: DirectoryNode,
    zone: DragZone = "tree",
  ) => {
    if (active || blank) return;
    suppressNextClick = false;
    clearPress();
    if (tree.locked.value || event.button !== 0 || event.isPrimary === false)
      return;
    const target = event.target as HTMLElement;
    const button = target.closest("button");

    if (
      target.closest(
        "form, input, textarea, select, a, [contenteditable], .row-action",
      ) ||
      (button && !button.classList.contains("directory-name"))
    )
      return;
    const press: RowPress = {
      item,
      zone,
      element: event.currentTarget as HTMLElement,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      x: event.clientX,
      y: event.clientY,
      modified: event.ctrlKey || event.metaKey || event.shiftKey,
    };

    pending = press;
    x = press.x;
    y = press.y;
    if (press.pointerType === "touch" && !press.modified)
      hold = setTimeout(() => activate(press), 500);
  };
  const startBlank = (event: PointerEvent) => {
    if (
      active ||
      pending ||
      blank ||
      tree.locked.value ||
      event.button !== 0 ||
      event.isPrimary === false ||
      event.pointerType === "touch"
    )
      return;
    suppressNextClick = false;
    const target = event.target as HTMLElement;

    if (
      target.closest(
        "[data-directory-key], button, input, form, a, [contenteditable], .section-heading, .branch-status, [data-favorite-list]",
      )
    )
      return;
    const heading = options
      .host()
      ?.querySelector<HTMLElement>('[data-drop-zone="tree"]');

    if (!heading || event.clientY < heading.getBoundingClientRect().bottom)
      return;
    root = options.host()?.closest<HTMLElement>(".sidebar-scroll") ?? null;
    if (!root) return;
    const element = options.host()!;

    element.focus({ preventScroll: true });
    x = event.clientX;
    y = event.clientY;
    blank = {
      element,
      pointerId: event.pointerId,
      x,
      y,
      start: contentPoint({ x, y }),
      base: options.selection.snapshot(),
      mode:
        event.ctrlKey || event.metaKey
          ? "xor"
          : event.shiftKey
            ? "add"
            : "replace",
      active: false,
    };
  };
  const move = (event: PointerEvent) => {
    if (blank?.pointerId === event.pointerId) {
      x = event.clientX;
      y = event.clientY;
      if (!blank.active && Math.hypot(x - blank.x, y - blank.y) >= 6) {
        blank.active = true;
        blank.element.setPointerCapture(event.pointerId);
        changed(true);
        frame = requestAnimationFrame(scroll);
      }

      if (blank.active) {
        if (event.cancelable) event.preventDefault();
        updateBox();
      }

      return;
    }

    if (pending?.pointerId === event.pointerId) {
      x = event.clientX;
      y = event.clientY;
      const distance = Math.hypot(x - pending.x, y - pending.y);

      if (pending.pointerType === "touch") {
        if (distance > 10) clearPress();

        return;
      }

      if (distance < 6) return;
      if (pending.modified) {
        suppressNextClick = true;
        clearPress();

        return;
      }

      activate(pending);
    }

    if (active?.pointerId !== event.pointerId) return;
    if (event.cancelable) event.preventDefault();
    x = event.clientX;
    y = event.clientY;
    targetAtPointer();
  };
  const complete = () => {
    const state = drag.value;

    cancel();
    if (!state?.drop) return;
    const drop = state.drop;

    void tree.attempt(async () => {
      if (drop.zone === "favorites") {
        if (
          state.zone === "favorites" &&
          drop.target &&
          drop.placement !== "end"
        )
          await tree.orderFavorite(state.item, drop.target, drop.placement);
        else await tree.favorite(state.item, true);
      } else if (state.batch) {
        const outcome = await tree.moveMany({
          sources: state.items.map(({ kind, id }) => ({ kind, id })),
          parentId: drop.parentId,
          target: drop.target,
          placement: drop.placement,
          catalogRevision: state.catalogRevision,
        });

        if (outcome.kind === "applied") options.selection.clear();
      } else
        await tree.move({
          source: state.item,
          parentId: drop.parentId,
          target: drop.target,
          placement: drop.placement,
        });
    });
  };
  const finish = (event: PointerEvent) => {
    if (blank?.pointerId === event.pointerId) {
      x = event.clientX;
      y = event.clientY;
      if (blank.active) updateBox();
      else if (blank.mode === "replace") options.selection.clear();
      endBox(false);

      return;
    }

    if (pending?.pointerId === event.pointerId) clearPress();
    if (active?.pointerId !== event.pointerId || active.pointerType === "touch")
      return;
    x = event.clientX;
    y = event.clientY;
    targetAtPointer();
    complete();
  };
  const suppressClick = (event: MouseEvent) => {
    if (!suppressNextClick || event.detail === 0) return;
    suppressNextClick = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || options.deferEscape()) return;
    if (!cancel() && !options.clearWithEscape(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const pointerCancel = (event: PointerEvent) => {
    if (blank?.pointerId === event.pointerId) cancel();
    if (pending?.pointerId === event.pointerId) clearPress();
    if (active?.pointerId === event.pointerId && active.pointerType !== "touch")
      cancel();
  };
  const touchMove = (event: TouchEvent) => {
    if (active?.pointerType !== "touch") return;
    if (event.touches.length !== 1) {
      cancel();

      return;
    }

    if (event.cancelable) event.preventDefault();
    x = event.touches[0]!.clientX;
    y = event.touches[0]!.clientY;
    targetAtPointer();
  };
  const touchEnd = (event: TouchEvent) => {
    if (active?.pointerType !== "touch") return;
    if (event.cancelable) event.preventDefault();
    const touch = event.changedTouches[0];

    if (touch) {
      x = touch.clientX;
      y = touch.clientY;
    }

    targetAtPointer();
    complete();
  };
  const preventTouchMenu = (event: MouseEvent) => {
    if (pending?.pointerType !== "touch" && active?.pointerType !== "touch")
      return;
    event.preventDefault();
    event.stopPropagation();
  };
  const preventNativeDrag = (event: DragEvent) => {
    if (pending || active) event.preventDefault();
  };

  onMounted(() => {
    document.addEventListener("keydown", escape, true);
    document.addEventListener("pointermove", move, {
      capture: true,
      passive: false,
    });
    document.addEventListener("pointerup", finish, true);
    document.addEventListener("pointercancel", pointerCancel, true);
    document.addEventListener("touchmove", touchMove, {
      capture: true,
      passive: false,
    });
    document.addEventListener("touchend", touchEnd, {
      capture: true,
      passive: false,
    });
    document.addEventListener("touchcancel", cancel, true);
    document.addEventListener("contextmenu", preventTouchMenu, true);
    document.addEventListener("dragstart", preventNativeDrag, true);
    window.addEventListener("blur", cancel);
  });
  onBeforeUnmount(() => {
    cancel();
    document.removeEventListener("keydown", escape, true);
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", finish, true);
    document.removeEventListener("pointercancel", pointerCancel, true);
    document.removeEventListener("touchmove", touchMove, true);
    document.removeEventListener("touchend", touchEnd, true);
    document.removeEventListener("touchcancel", cancel, true);
    document.removeEventListener("contextmenu", preventTouchMenu, true);
    document.removeEventListener("dragstart", preventNativeDrag, true);
    window.removeEventListener("blur", cancel);
  });

  return {
    drag: shallowReadonly(drag),
    box: shallowReadonly(box),
    startBlank,
    start,
    cancel,
    cancelPress: clearPress,
    suppressClick,
  };
};
