import { onBeforeUnmount, onMounted, ref, shallowReadonly } from "vue";
import type { DirectoryNode, NodeRef } from "#shared/directory-contracts";
import type { DirectoryTreeController } from "~/composables/use-directory-tree";
import { nodeKey } from "~/lib/directory-api";

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
}

/** 整行手势只生成目录意图；轻触、滚动和拖动分别结束，不接管编辑器。 */
export const useDirectoryDrag = (
  tree: DirectoryTreeController,
  changed: (active: boolean) => void,
) => {
  const drag = ref<{
    item: DirectoryNode;
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
  const insideSource = (target: DirectoryNode) => {
    const source = drag.value?.item;
    let parent = target.parentId;

    if (!source || source.kind !== "folder") return false;
    if (target.kind === "folder" && source.id === target.id) return true;
    while (parent) {
      if (parent === source.id) return true;
      parent = tree.known.value[`folder:${parent}`]?.parentId ?? null;
    }

    return false;
  };
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

    if (!item) {
      drag.value.drop = { zone, parentId: null, placement: "end" };
      clearHover();

      return;
    }

    if (
      nodeKey(item) === nodeKey(drag.value.item) ||
      (zone === "tree" && insideSource(item))
    ) {
      drag.value.reason = "不能移动到自身或自己的子文件夹";
      clearHover();

      return;
    }

    const bounds = element.getBoundingClientRect();
    const inside = !gap && zone === "tree" && item.kind === "folder";
    const source = drag.value.item;
    const parent = inside
      ? item
      : item.parentId
        ? tree.known.value[`folder:${item.parentId}`]
        : undefined;

    if (
      zone === "tree" &&
      source.kind === "folder" &&
      (parent?.kind === "folder" ? parent.depth : 0) + source.subtreeDepth > 5
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
  const scroll = () => {
    if (!drag.value) return;
    if (root) {
      const bounds = root.getBoundingClientRect();
      const delta = y < bounds.top + 42 ? -9 : y > bounds.bottom - 42 ? 9 : 0;

      if (delta) root.scrollTop += delta;
    }

    targetAtPointer();
    frame = requestAnimationFrame(scroll);
  };
  const cancel = () => {
    const previous = active;

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
    drag.value = {
      item: press.item,
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
    if (active) return;
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
    };

    pending = press;
    x = press.x;
    y = press.y;
    if (press.pointerType === "touch")
      hold = setTimeout(() => activate(press), 500);
  };
  const move = (event: PointerEvent) => {
    if (pending?.pointerId === event.pointerId) {
      x = event.clientX;
      y = event.clientY;
      const distance = Math.hypot(x - pending.x, y - pending.y);

      if (pending.pointerType === "touch") {
        if (distance > 10) clearPress();

        return;
      }

      if (distance < 6) return;
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
    if (event.key !== "Escape" || (!drag.value && !pending)) return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
  const pointerCancel = (event: PointerEvent) => {
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
    start,
    cancel,
    cancelPress: clearPress,
    suppressClick,
  };
};
