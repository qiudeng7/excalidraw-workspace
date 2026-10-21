import { ref, shallowReadonly, onMounted, onBeforeUnmount } from "vue";
import type { Ref } from "vue";
import type { CanvasMeta } from "#shared/contracts";

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
  move?(
    id: string,
    targetId: string,
    placement: "before" | "after",
  ): Promise<void>;
  loadNextPage?(): Promise<void>;
  hasMore?: Readonly<Ref<boolean>>;
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

export const useCanvasReorder = ({
  canvases,
  locked,
  reorder,
  move,
  loadNextPage,
  hasMore,
}: CanvasReorderDependencies): CanvasReorderController => {
  const drag = ref<CanvasDrag>();
  let animation = 0;
  let pointerY = 0;
  let pointerX = 0;
  let moving = false;
  const submitMove = async (
    id: string,
    targetId: string,
    placement: "before" | "after",
  ) => {
    if (move) {
      await move(id, targetId, placement);

      return;
    }

    const ids = canvases.value
      .map((item) => item.id)
      .filter((entry) => entry !== id);
    const target = ids.indexOf(targetId);

    ids.splice(target + (placement === "after" ? 1 : 0), 0, id);
    await reorder(ids);
  };
  const moveAdjacent = async (canvas: CanvasMeta, offset: number) => {
    if (locked.value || moving) {
      return;
    }

    moving = true;
    try {
      const index = canvases.value.findIndex((entry) => entry.id === canvas.id);

      if (offset > 0 && index === canvases.value.length - 1 && hasMore?.value) {
        await loadNextPage?.();
      }

      const currentIndex = canvases.value.findIndex(
        (entry) => entry.id === canvas.id,
      );
      const neighbor = canvases.value[currentIndex + offset];

      if (
        !locked.value &&
        currentIndex >= 0 &&
        neighbor &&
        !!neighbor.pinned === !!canvas.pinned
      ) {
        await submitMove(
          canvas.id,
          neighbor.id,
          offset < 0 ? "before" : "after",
        );
      }
    } finally {
      moving = false;
    }
  };
  const moveCanvas = (canvas: CanvasMeta, offset: number) => {
    void moveAdjacent(canvas, offset);
  };
  const updateTarget = () => {
    if (!drag.value) {
      return;
    }

    const row = window.document
      .elementFromPoint(pointerX, pointerY)
      ?.closest<HTMLElement>("[data-canvas-id]");
    const source = canvases.value.find((entry) => entry.id === drag.value?.id);
    const target = canvases.value.find(
      (entry) => entry.id === row?.dataset.canvasId,
    );

    drag.value.targetId =
      target && !!target.pinned === !!source?.pinned
        ? target.id
        : drag.value.id;
  };
  const autoScroll = () => {
    const root = drag.value?.handle.closest(".sidebar-scroll");

    if (!(root instanceof HTMLElement) || !drag.value) {
      return;
    }

    const bounds = root.getBoundingClientRect();
    const delta =
      pointerY < bounds.top + 48 ? -10 : pointerY > bounds.bottom - 48 ? 10 : 0;

    if (delta) {
      root.scrollTop += delta;
      updateTarget();
    }

    animation = requestAnimationFrame(autoScroll);
  };
  const startDrag = (event: PointerEvent, canvas: CanvasMeta) => {
    if (locked.value || event.button !== 0) {
      return;
    }

    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;

    handle.setPointerCapture(event.pointerId);
    pointerY = event.clientY;
    pointerX = event.clientX;
    drag.value = {
      id: canvas.id,
      targetId: canvas.id,
      pointerId: event.pointerId,
      handle,
    };
    animation = requestAnimationFrame(autoScroll);
  };
  const dragMove = (event: PointerEvent) => {
    if (!drag.value || drag.value.pointerId !== event.pointerId) {
      return;
    }

    pointerY = event.clientY;
    pointerX = event.clientX;
    updateTarget();
  };
  const cancelDrag = () => {
    const current = drag.value;

    drag.value = undefined;
    cancelAnimationFrame(animation);
    if (current?.handle.hasPointerCapture(current.pointerId)) {
      current.handle.releasePointerCapture(current.pointerId);
    }
  };
  const finishDrag = (event: PointerEvent) => {
    const current = drag.value;

    if (!current || current.pointerId !== event.pointerId) {
      return;
    }

    const source = canvases.value.findIndex((entry) => entry.id === current.id);
    const target = canvases.value.findIndex(
      (entry) => entry.id === current.targetId,
    );

    cancelDrag();
    if (
      !locked.value &&
      source >= 0 &&
      target >= 0 &&
      source !== target &&
      !!canvases.value[source]?.pinned === !!canvases.value[target]?.pinned
    ) {
      void submitMove(
        current.id,
        current.targetId,
        source < target ? "after" : "before",
      );
    }
  };
  const dragKey = (event: KeyboardEvent, canvas: CanvasMeta) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDrag();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      moveCanvas(canvas, event.key === "ArrowUp" ? -1 : 1);
    }
  };
  const escape = (event: KeyboardEvent) => {
    if (drag.value && event.key === "Escape") {
      event.preventDefault();
      cancelDrag();
    }
  };

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
};
