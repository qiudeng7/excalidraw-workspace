import { sceneCoordsToViewportCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

/** Read the displayed scene and decorate it without changing editor selection or data. */
export const createEditorSearch = (
  getEditor: () => ExcalidrawImperativeAPI | undefined,
  getCanvasId: () => string,
  getHost: () => HTMLElement | null | undefined,
) => {
  let outline: HTMLDivElement | undefined;
  let layer: HTMLDivElement | undefined;
  let targetId = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let subscriptions: (() => void)[] = [];
  let observer: ResizeObserver | undefined;

  const clear = () => {
    clearTimeout(timeout);
    for (const unsubscribe of subscriptions) unsubscribe();
    subscriptions = [];
    observer?.disconnect();
    observer = undefined;
    layer?.remove();
    layer = undefined;
    outline = undefined;
    targetId = "";
  };
  const update = () => {
    const editor = getEditor();
    const host = getHost();
    const element = editor
      ?.getSceneElements()
      .find((item) => item.id === targetId);

    if (!editor || !host || !element || !outline) {
      clear();

      return;
    }

    const state = editor.getAppState();
    const point = sceneCoordsToViewportCoords(
      {
        sceneX: element.x + element.width / 2,
        sceneY: element.y + element.height / 2,
      },
      state,
    );
    const bounds = host.getBoundingClientRect();
    const width = element.width * state.zoom.value;
    const height = element.height * state.zoom.value;

    Object.assign(outline.style, {
      left: `${point.x - bounds.left - width / 2}px`,
      top: `${point.y - bounds.top - height / 2}px`,
      width: `${Math.max(width, 2)}px`,
      height: `${Math.max(height, 2)}px`,
      transform: `rotate(${element.angle}rad)`,
    });
  };
  const locateElement = (id: string) => {
    clear();
    const editor = getEditor();
    const host = getHost();

    if (
      !editor ||
      editor.isDestroyed ||
      !host ||
      !editor.getSceneElements().some((item) => item.id === id)
    )
      return false;
    targetId = id;
    outline = document.createElement("div");
    outline.dataset.testid = "search-target-highlight";
    outline.setAttribute("aria-hidden", "true");
    Object.assign(outline.style, {
      position: "absolute",
      pointerEvents: "none",
      zIndex: "25",
      boxSizing: "border-box",
      border: "3px solid #e5a800",
      background: "rgba(255, 213, 64, 0.14)",
      borderRadius: "3px",
      boxShadow: "0 0 0 2px rgba(255,255,255,.8)",
    });
    layer = document.createElement("div");
    Object.assign(layer.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      overflow: "hidden",
      zIndex: "25",
    });
    layer.append(outline);
    host.append(layer);
    subscriptions = [editor.onChange(update), editor.onScrollChange(update)];
    observer = new ResizeObserver(update);
    observer.observe(host);
    window.addEventListener("resize", update);
    subscriptions.push(() => window.removeEventListener("resize", update));
    editor.setViewport({
      target: id,
      fit: "scale-down",
      animation: { duration: 300 },
      offsets: { ui: true },
    });
    host.querySelector<HTMLElement>(".excalidraw")?.focus();
    update();
    timeout = setTimeout(clear, 2000);

    return true;
  };

  return {
    readSearchScene: () => {
      const editor = getEditor();

      return editor && !editor.isDestroyed
        ? { canvasId: getCanvasId(), elements: editor.getSceneElements() }
        : undefined;
    },
    locateElement,
    dispose: clear,
  };
};
