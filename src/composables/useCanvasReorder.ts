import {
  ref,
  shallowReadonly,
  onMounted,
  onBeforeUnmount,
  type Ref,
} from "vue";
import type { CanvasMeta } from "../../shared/contracts";

export interface CanvasDrag {
  id: string;
  targetId: string;
  pointerId: number;
  handle: HTMLElement;
}

export interface CanvasReorderDependencies {
  canvases: Readonly<Ref<readonly CanvasMeta[]>>;
  locked: Readonly<Ref<boolean>>;
  reorder(ids: string[]): Promise<void>;
}

export interface CanvasReorderController {
  drag: Readonly<Ref<CanvasDrag | undefined>>;
  moveCanvas(canvas: CanvasMeta, offset: number): void;
  startDrag(event: PointerEvent, canvas: CanvasMeta): void;
  dragMove(event: PointerEvent): void;
  cancelDrag(): void;
  finishDrag(event: PointerEvent): void;
  dragKey(event: KeyboardEvent, canvas: CanvasMeta): void;
}

export function useCanvasReorder({
  canvases,
  locked,
  reorder,
}: CanvasReorderDependencies): CanvasReorderController {
  const drag = ref<CanvasDrag>();

  function moveCanvas(canvas: CanvasMeta, offset: number) {
    const ids = canvases.value.map((item) => item.id);
    const index = ids.indexOf(canvas.id),
      target = index + offset;

    if (target < 0 || target >= ids.length) return;
    ids.splice(index, 1);
    ids.splice(target, 0, canvas.id);
    void reorder(ids);
  }

  function startDrag(event: PointerEvent, canvas: CanvasMeta) {
    if (locked.value || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;

    handle.setPointerCapture(event.pointerId);
    drag.value = {
      id: canvas.id,
      targetId: canvas.id,
      pointerId: event.pointerId,
      handle,
    };
  }

  function dragMove(event: PointerEvent) {
    if (!drag.value || drag.value.pointerId !== event.pointerId) return;
    const row = window.document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-canvas-id]");

    if (
      row?.dataset.canvasId &&
      canvases.value.some((canvas) => canvas.id === row.dataset.canvasId)
    )
      drag.value.targetId = row.dataset.canvasId;
  }

  function cancelDrag() {
    const current = drag.value;

    drag.value = undefined;
    if (current?.handle.hasPointerCapture(current.pointerId))
      current.handle.releasePointerCapture(current.pointerId);
  }

  function finishDrag(event: PointerEvent) {
    const current = drag.value;

    if (!current || current.pointerId !== event.pointerId) return;
    const ids = canvases.value.map((item) => item.id),
      target = ids.indexOf(current.targetId);

    ids.splice(ids.indexOf(current.id), 1);
    ids.splice(target, 0, current.id);
    cancelDrag();
    void reorder(ids);
  }

  function dragKey(event: KeyboardEvent, canvas: CanvasMeta) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDrag();

      return;
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      moveCanvas(canvas, event.key === "ArrowUp" ? -1 : 1);
    }
  }

  function escape(event: KeyboardEvent) {
    if (drag.value && event.key === "Escape") {
      event.preventDefault();
      cancelDrag();
    }
  }

  onMounted(() => window.document.addEventListener("keydown", escape));
  onBeforeUnmount(() => {
    cancelDrag();
    window.document.removeEventListener("keydown", escape);
  });

  return {
    drag: shallowReadonly(drag),
    moveCanvas,
    startDrag,
    dragMove,
    cancelDrag,
    finishDrag,
    dragKey,
  };
}
