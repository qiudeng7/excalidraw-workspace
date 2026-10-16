import { isTextElement } from "@excalidraw/element";
import { deepCopyElement } from "@excalidraw/element";

import { CODES, KEYS, isFirefox } from "@excalidraw/common";

import { CaptureUpdateAction } from "@excalidraw/element";

import {
  copyTextToSystemClipboard,
  copyToClipboard,
  createPasteEvent,
  probablySupportsClipboardBlob,
  probablySupportsClipboardWriteText,
  readSystemClipboard,
  serializeAsClipboardJSON,
  isRestorableClipboardSelection,
} from "../clipboard";
import { exportToCanvas } from "../lib/utils/src/export";
import {
  beginClipboardOperation,
  isCurrentClipboardOperation,
  encodeNativeClipboard,
  createClipboardHTML,
  getSemanticClipboardText,
  writeSmartClipboard,
} from "../smartClipboard";
import type { AppClassProperties } from "../types";
import type { ActionResult } from "./types";

const copySelection = (
  app: AppClassProperties,
  event?: ClipboardEvent | null,
) => {
  const token = beginClipboardOperation();
  const selected = app.scene.getSelectedElements({
    selectedElementIds: app.state.selectedElementIds,
    includeBoundTextElement: true,
    includeElementsInFrames: true,
  });
  const snapshot = selected.map((element) => deepCopyElement(element));
  const json = serializeAsClipboardJSON({
    elements: snapshot,
    files: app.files,
  });
  const encoded = encodeNativeClipboard(json);

  if (!isRestorableClipboardSelection(snapshot))
    throw new Error("所选元素无法完整恢复，复制已取消；原元素保留。");
  const fallbackHTML = createClipboardHTML(encoded, snapshot);
  const graphics = snapshot.filter((element) => !isTextElement(element));
  const html = graphics.length
    ? exportToCanvas({
        // No text or bound labels in the preview: every label is editable HTML exactly once.
        elements: graphics,
        files: app.files,
        appState: {
          ...app.state,
          exportScale: 1,
          exportBackground: false,
          frameRendering: {
            enabled: false,
            name: false,
            outline: false,
            clip: false,
          },
        },
        maxWidthOrHeight: 4096,
      }).then((canvas) =>
        createClipboardHTML(encoded, snapshot, canvas.toDataURL("image/png")),
      )
    : Promise.resolve(fallbackHTML);

  return {
    token,
    snapshot,
    result: writeSmartClipboard({
      plain: getSemanticClipboardText(snapshot),
      html,
      fallbackHTML,
      event,
      token,
    }),
  };
};
const copyFailure = (error: unknown): ActionResult => ({
  captureUpdate: CaptureUpdateAction.EVENTUALLY,
  appState: {
    errorMessage:
      error instanceof Error ? error.message : "复制失败，请检查剪贴板权限。",
  },
});
const incompleteCopy = (): ActionResult => ({
  captureUpdate: CaptureUpdateAction.EVENTUALLY,
  appState: {
    errorMessage:
      "浏览器仅支持降级复制，未完整写入图文。原元素保留；请在支持 ClipboardItem 的安全上下文重试。",
  },
});

import { DuplicateIcon, cutIcon, pngIcon, svgIcon } from "../components/icons";
import { exportCanvas, prepareElementsForExport } from "../data/index";
import { t } from "../i18n";

import { actionDeleteSelected } from "./actionDeleteSelected";
import { register } from "./register";

export const actionCopy = register<ClipboardEvent | null>({
  name: "copy",
  label: "labels.smartCopy",
  icon: DuplicateIcon,
  trackEvent: { category: "element" },
  perform: async (elements, appState, event, app) => {
    let token: number | undefined;

    try {
      const copy = copySelection(app, event);

      token = copy.token;
      const result = await copy.result;

      if (!result.current) return false;
      if (!result.complete) return incompleteCopy();

      return { captureUpdate: CaptureUpdateAction.EVENTUALLY };
    } catch (error) {
      if (token !== undefined && !isCurrentClipboardOperation(token))
        return false;

      return copyFailure(error);
    }
  },
  // don't supply a shortcut since we handle this conditionally via onCopy event
  keyTest: undefined,
});

export const actionCopyCompatible = register<ClipboardEvent | null>({
  name: "copyCompatible",
  label: "labels.copyCompatible",
  icon: DuplicateIcon,
  trackEvent: { category: "element" },
  perform: async (_elements, _state, event, app) => {
    try {
      await copyToClipboard(
        app.scene.getSelectedElements({
          selectedElementIds: app.state.selectedElementIds,
          includeBoundTextElement: true,
          includeElementsInFrames: true,
        }),
        app.files,
        event,
      );

      return { captureUpdate: CaptureUpdateAction.EVENTUALLY };
    } catch (error) {
      return copyFailure(error);
    }
  },
});

export const actionPaste = register({
  name: "paste",
  label: "labels.paste",
  trackEvent: { category: "element" },
  perform: async (elements, appState, data, app) => {
    let types;

    try {
      types = await readSystemClipboard();
    } catch (error: any) {
      if (error.name === "AbortError" || error.name === "NotAllowedError") {
        // user probably aborted the action. Though not 100% sure, it's best
        // to not annoy them with an error message.
        return false;
      }

      console.error(`actionPaste ${error.name}: ${error.message}`);

      if (isFirefox) {
        return {
          captureUpdate: CaptureUpdateAction.EVENTUALLY,
          appState: {
            ...appState,
            errorMessage: t("hints.firefox_clipboard_write"),
          },
        };
      }

      return {
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
        appState: {
          errorMessage: t("errors.asyncPasteFailedOnRead"),
        },
      };
    }

    try {
      app.pasteFromClipboard(createPasteEvent({ types }));
    } catch (error: any) {
      console.error(error);

      return {
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
        appState: {
          errorMessage: t("errors.asyncPasteFailedOnParse"),
        },
      };
    }

    return {
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
  // don't supply a shortcut since we handle this conditionally via onCopy event
  keyTest: undefined,
});

export const actionCut = register<ClipboardEvent | null>({
  name: "cut",
  label: "labels.cut",
  icon: cutIcon,
  trackEvent: { category: "element" },
  perform: async (_elements, _appState, event, app) => {
    let token: number | undefined;
    const selection = JSON.stringify(app.state.selectedElementIds);
    const scene = app.scene.getElementsIncludingDeleted();

    try {
      const copy = copySelection(app, event);

      token = copy.token;
      const result = await copy.result;

      if (!result.current) return false;
      if (!result.complete) return incompleteCopy();
      const live = app.scene.getNonDeletedElementsMap();
      const currentSelection = app.scene.getSelectedElements({
        selectedElementIds: app.state.selectedElementIds,
        includeBoundTextElement: true,
        includeElementsInFrames: true,
      });

      if (
        app.api.isDestroyed ||
        app.scene.getElementsIncludingDeleted() !== scene ||
        currentSelection.length !== copy.snapshot.length ||
        currentSelection.some(
          (element) => !copy.snapshot.some((old) => old.id === element.id),
        ) ||
        !app.isInteractionEnabled() ||
        app.props.syncReadOnly ||
        app.state.viewModeEnabled ||
        JSON.stringify(app.state.selectedElementIds) !== selection ||
        copy.snapshot.some((element) => {
          const current = live.get(element.id);

          return (
            !current ||
            current.version !== element.version ||
            current.versionNonce !== element.versionNonce
          );
        })
      ) {
        return {
          captureUpdate: CaptureUpdateAction.EVENTUALLY,
          appState: {
            toast: { message: "已复制；选区或内容已变化，未剪切任何元素。" },
          },
        };
      }

      // Use fresh scene and state, never replay the pre-copy scene after an await.
      return actionDeleteSelected.perform(
        app.scene.getElementsIncludingDeleted(),
        app.state,
        null,
        app,
      );
    } catch (error) {
      if (token !== undefined && !isCurrentClipboardOperation(token))
        return false;

      return copyFailure(error);
    }
  },
  keyTest: (event) => event[KEYS.CTRL_OR_CMD] && event.key === KEYS.X,
});

export const actionCopyAsSvg = register({
  name: "copyAsSvg",
  label: "labels.copyAsSvg",
  icon: svgIcon,
  trackEvent: { category: "element" },
  perform: async (elements, appState, _data, app) => {
    if (!app.canvas) {
      return {
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    }

    const { exportedElements, exportingFrame } = prepareElementsForExport(
      elements,
      appState,
      true,
    );

    try {
      await exportCanvas(
        "clipboard-svg",
        exportedElements,
        appState,
        app.files,
        {
          ...appState,
          exportingFrame,
          name: app.getName(),
        },
      );

      const selectedElements = app.scene.getSelectedElements({
        selectedElementIds: appState.selectedElementIds,
        includeBoundTextElement: true,
        includeElementsInFrames: true,
      });

      return {
        appState: {
          toast: {
            message: t("toast.copyToClipboardAsSvg", {
              exportSelection: selectedElements.length
                ? t("toast.selection")
                : t("toast.canvas"),
              exportColorScheme: appState.exportWithDarkMode
                ? t("buttons.darkMode")
                : t("buttons.lightMode"),
            }),
          },
        },
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    } catch (error: any) {
      console.error(error);

      return {
        appState: {
          errorMessage: error.message,
        },
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    }
  },
  predicate: (elements) => {
    return probablySupportsClipboardWriteText && elements.length > 0;
  },
  keywords: ["svg", "clipboard", "copy"],
});

export const actionCopyAsPng = register({
  name: "copyAsPng",
  label: "labels.copyAsPng",
  icon: pngIcon,
  trackEvent: { category: "element" },
  perform: async (elements, appState, _data, app) => {
    if (!app.canvas) {
      return {
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    }

    const selectedElements = app.scene.getSelectedElements({
      selectedElementIds: appState.selectedElementIds,
      includeBoundTextElement: true,
      includeElementsInFrames: true,
    });

    const { exportedElements, exportingFrame } = prepareElementsForExport(
      elements,
      appState,
      true,
    );

    try {
      await exportCanvas("clipboard", exportedElements, appState, app.files, {
        ...appState,
        exportingFrame,
        name: app.getName(),
      });

      return {
        appState: {
          toast: {
            message: t("toast.copyToClipboardAsPng", {
              exportSelection: selectedElements.length
                ? t("toast.selection")
                : t("toast.canvas"),
              exportColorScheme: appState.exportWithDarkMode
                ? t("buttons.darkMode")
                : t("buttons.lightMode"),
            }),
          },
        },
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    } catch (error: any) {
      console.error(error);

      return {
        appState: {
          errorMessage: error.message,
        },
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    }
  },
  predicate: (elements) => {
    return probablySupportsClipboardBlob && elements.length > 0;
  },
  keyTest: (event) =>
    event.code === CODES.C &&
    event[KEYS.CTRL_OR_CMD] &&
    event.shiftKey &&
    !event.altKey,
  keywords: ["png", "clipboard", "copy"],
});

export const copyText = register({
  name: "copyText",
  label: "labels.copyText",
  trackEvent: { category: "element" },
  perform: async (elements, appState, _, app) => {
    const selectedElements = app.scene.getSelectedElements({
      selectedElementIds: appState.selectedElementIds,
      includeBoundTextElement: true,
    });

    try {
      beginClipboardOperation();
      await copyTextToSystemClipboard(
        getSemanticClipboardText(selectedElements),
      );
    } catch (e) {
      return copyFailure(
        new Error(t("errors.copyToSystemClipboardFailed"), { cause: e }),
      );
    }

    return {
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
  predicate: (elements, appState, _, app) => {
    return (
      probablySupportsClipboardWriteText &&
      app.scene
        .getSelectedElements({
          selectedElementIds: appState.selectedElementIds,
          includeBoundTextElement: true,
        })
        .some(isTextElement)
    );
  },
  keywords: ["text", "clipboard", "copy"],
});
