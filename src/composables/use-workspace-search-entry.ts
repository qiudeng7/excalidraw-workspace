import { nextTick, onScopeDispose, ref, watch } from "vue";
import type { CanvasSearchGroup } from "#shared/workspace-search";
import type { EditorHandle } from "~/lib/editor";
import type { WorkspaceSearchController } from "~/composables/use-workspace-search";

/** Both search entries share focus transfer and the existing canvas-navigation path. */
export const useWorkspaceSearchEntry = (options: {
  search: WorkspaceSearchController;
  ownerId: () => string | undefined;
  workspaceId: () => string;
  editor: () => EditorHandle | undefined;
  ready: () => boolean;
  blocked: () => boolean;
  selectCanvas: (id: string) => Promise<void>;
  report: (message: string) => void;
}) => {
  const sidebarInput = ref<HTMLInputElement>();
  const sidebarText = ref(options.search.query.value);
  const dialog = ref<{ focusInput(): void }>();
  const selection = ref<{ start: number; end: number }>();
  let composing = false;
  let pendingOpen = false;
  let returnFocus: HTMLElement | undefined;
  let generation = 0;
  let navigationTimer: ReturnType<typeof setTimeout> | undefined;
  let stopWaiting: (() => void) | undefined;
  let frame: number | undefined;

  const cancelNavigation = () => {
    generation++;
    clearTimeout(navigationTimer);
    stopWaiting?.();
    stopWaiting = undefined;
  };
  const show = () => {
    if (options.blocked() || !options.ownerId() || !options.workspaceId())
      return;
    if (composing) {
      pendingOpen = true;

      return;
    }

    if (options.search.open.value) {
      dialog.value?.focusInput();

      return;
    }

    cancelNavigation();
    returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const input = sidebarInput.value;

    selection.value =
      document.activeElement === input && input
        ? {
            start: input.selectionStart ?? sidebarText.value.length,
            end: input.selectionEnd ?? sidebarText.value.length,
          }
        : undefined;
    options.search.show();
  };
  const close = () => {
    pendingOpen = false;
    cancelNavigation();
    options.search.close();
    void nextTick(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
    });
  };
  const sidebarChanged = (event: Event) => {
    sidebarText.value = (event.target as HTMLInputElement).value;
    if (composing || (event as InputEvent).isComposing) return;
    options.search.setQuery(sidebarText.value);
    if (sidebarText.value && frame === undefined) show();
  };
  const compositionStart = () => {
    composing = true;
  };
  const compositionEnd = (event: CompositionEvent) => {
    composing = false;
    if (event.target === sidebarInput.value) {
      sidebarText.value = sidebarInput.value.value;
      options.search.setQuery(sidebarText.value);
      pendingOpen = !!sidebarText.value;
    }

    if (pendingOpen) {
      pendingOpen = false;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        show();
      });
    }
  };
  const shortcut = (event: KeyboardEvent) => {
    const primary = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (
      primary &&
      !event.altKey &&
      !event.shiftKey &&
      key === "p" &&
      options.ownerId()
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) {
        if (event.isComposing || event.keyCode === 229) pendingOpen = true;
        else show();
      }
    } else if (
      options.search.open.value &&
      primary &&
      ["f", "p", "/"].includes(key)
    ) {
      // Excalidraw's command palette listens at window capture, outside native dialog inertness.
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const select = async (
    canvas: CanvasSearchGroup["canvas"],
    elementId?: string,
  ) => {
    cancelNavigation();
    options.search.close();
    const request = generation;
    const owner = options.ownerId();
    const workspace = options.workspaceId();

    if (canvas.workspaceId !== workspace) return;
    const finish = () => {
      if (
        request !== generation ||
        owner !== options.ownerId() ||
        workspace !== options.workspaceId()
      )
        return;
      const editor = options.editor();

      if (
        !editor ||
        !options.ready() ||
        editor.readSearchScene()?.canvasId !== canvas.id
      )
        return;
      cancelNavigation();
      if (elementId && !editor.locateElement(elementId))
        options.report("目标元素已不存在，画布仍已打开");
      if (!elementId)
        document
          .querySelector<HTMLElement>(".draw-editor .excalidraw")
          ?.focus();
    };

    stopWaiting = watch(
      () => [
        options.ready(),
        options.editor(),
        options.editor()?.readSearchScene()?.canvasId,
      ],
      finish,
      { flush: "post" },
    );
    navigationTimer = setTimeout(() => {
      if (request !== generation) return;
      cancelNavigation();
      options.report("画布尚未完成加载，请稍后重试定位");
    }, 5000);
    try {
      await options.selectCanvas(canvas.id);
      finish();
    } catch (cause) {
      if (request !== generation) return;
      cancelNavigation();
      options.report(cause instanceof Error ? cause.message : "无法打开画布");
    }
  };

  watch(options.search.query, (value) => {
    sidebarText.value = value;
    cancelNavigation();
  });
  watch(
    () => [options.ownerId(), options.workspaceId()],
    () => {
      pendingOpen = false;
      cancelNavigation();
      sidebarText.value = "";
    },
  );
  window.addEventListener("compositionstart", compositionStart, true);
  window.addEventListener("compositionend", compositionEnd, true);
  window.addEventListener("keydown", shortcut, true);
  onScopeDispose(() => {
    cancelNavigation();
    if (frame !== undefined) cancelAnimationFrame(frame);
    window.removeEventListener("compositionstart", compositionStart, true);
    window.removeEventListener("compositionend", compositionEnd, true);
    window.removeEventListener("keydown", shortcut, true);
  });

  return {
    sidebarInput,
    sidebarText,
    dialog,
    selection,
    sidebarChanged,
    show,
    close,
    select,
  };
};
