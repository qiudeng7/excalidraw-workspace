import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Ref } from "vue";
import type { CanvasMeta } from "#shared/contracts";

export interface CanvasMenuTarget {
  id: string;
  x: number;
  y: number;
  trigger: HTMLElement;
}

/** A single menu belongs to the visible directory, never to the active editor. */
export const useCanvasContextMenu = (options: {
  canvases: Readonly<Ref<readonly CanvasMeta[]>>;
  workspaceId: Readonly<Ref<string>>;
  enabled: Readonly<Ref<boolean>>;
}) => {
  const target = ref<CanvasMenuTarget>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let press: { id: number; x: number; y: number } | undefined;
  let suppressUntil = 0;
  let heldPointer: number | undefined;
  const scrollPositions = new Map<Element, { top: number; left: number }>();
  const rememberScroll = (trigger: HTMLElement) => {
    scrollPositions.clear();
    for (
      let element: Element | null = trigger;
      element;
      element = element.parentElement
    ) {
      scrollPositions.set(element, {
        top: element.scrollTop,
        left: element.scrollLeft,
      });
    }
  };

  const cancelPress = () => {
    clearTimeout(timer);
    timer = undefined;
    press = undefined;
  };
  const close = (restoreFocus = false) => {
    const trigger = target.value?.trigger;

    target.value = undefined;
    scrollPositions.clear();
    cancelPress();
    if (restoreFocus && trigger?.isConnected) trigger.focus();
  };
  const open = (
    event: MouseEvent | PointerEvent | KeyboardEvent,
    canvas: CanvasMeta,
    keyboard = false,
  ) => {
    if (!options.enabled.value) return;
    const row = event.currentTarget as HTMLElement;
    const trigger = row.matches(".canvas-name")
      ? row
      : row.querySelector<HTMLElement>(".canvas-name");

    if (!trigger) return;
    const bounds = trigger.getBoundingClientRect();

    rememberScroll(trigger);
    target.value = {
      id: canvas.id,
      x: keyboard ? bounds.left : (event as MouseEvent).clientX,
      y: keyboard ? bounds.bottom : (event as MouseEvent).clientY,
      trigger,
    };
  };
  const contextMenu = (event: MouseEvent, canvas: CanvasMeta) => {
    event.preventDefault();
    event.stopPropagation();
    cancelPress();
    open(event, canvas);
  };
  const keyDown = (event: KeyboardEvent, canvas: CanvasMeta) => {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey))
      return;
    event.preventDefault();
    event.stopPropagation();
    open(event, canvas, true);
  };
  const pointerDown = (event: PointerEvent, canvas: CanvasMeta) => {
    cancelPress();
    if (
      !options.enabled.value ||
      event.pointerType !== "touch" ||
      (event.target as HTMLElement).closest(".drag-handle")
    )
      return;
    const row = event.currentTarget as HTMLElement;
    const trigger = row.querySelector<HTMLElement>(".canvas-name");

    if (!trigger) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      if (!press || !options.enabled.value || !trigger.isConnected) return;
      rememberScroll(trigger);
      target.value = { id: canvas.id, x: press.x, y: press.y, trigger };
      heldPointer = press.id;
      cancelPress();
    }, 500);
  };
  const pointerMove = (event: PointerEvent) => {
    if (
      press?.id === event.pointerId &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10
    )
      cancelPress();
  };
  const pointerEnd = (event: PointerEvent) => {
    if (press?.id === event.pointerId) cancelPress();
    if (heldPointer !== event.pointerId) return;
    heldPointer = undefined;
    suppressUntil = event.type === "pointercancel" ? 0 : Date.now() + 1500;
    if (event.type === "pointercancel") close();
  };
  const suppressClick = (event: MouseEvent) => {
    if (heldPointer === undefined && Date.now() >= suppressUntil) return;
    heldPointer = undefined;
    suppressUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  };
  const clearGesture = () => {
    heldPointer = undefined;
    suppressUntil = 0;
    cancelPress();
  };
  const dismiss = () => {
    clearGesture();
    close();
  };
  const outside = (event: PointerEvent) => {
    clearGesture();
    if (!(event.target as HTMLElement).closest("[data-canvas-context-menu]"))
      close();
  };
  const scroll = (event: Event) => {
    const element =
      event.target instanceof Element
        ? event.target
        : document.scrollingElement;

    if (element?.closest("[data-canvas-context-menu]")) return;
    cancelPress();
    const previous = element && scrollPositions.get(element);

    // A click may scroll its row into view before opening, but dispatch scroll later.
    if (
      element &&
      previous &&
      previous.top === element.scrollTop &&
      previous.left === element.scrollLeft
    )
      return;
    close();
  };
  const blur = () => dismiss();

  watch([options.workspaceId, options.enabled], () => dismiss());
  watch(options.canvases, (canvases) => {
    cancelPress();
    if (
      target.value &&
      !canvases.some((canvas) => canvas.id === target.value?.id)
    )
      close();
  });
  onMounted(() => {
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("pointermove", pointerMove, true);
    window.addEventListener("pointerup", pointerEnd, true);
    window.addEventListener("pointercancel", pointerEnd, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", blur);
  });
  onBeforeUnmount(() => {
    dismiss();
    window.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("pointermove", pointerMove, true);
    window.removeEventListener("pointerup", pointerEnd, true);
    window.removeEventListener("pointercancel", pointerEnd, true);
    window.removeEventListener("scroll", scroll, true);
    window.removeEventListener("blur", blur);
    window.removeEventListener("resize", blur);
  });

  return { target, close, contextMenu, keyDown, pointerDown, suppressClick };
};
