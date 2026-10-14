import { richTextSchema, richTextInputRules } from "./richTextEditor";
import { Slice, Fragment } from "prosemirror-model";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo, redo } from "prosemirror-history";
import { undoInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, chainCommands, toggleMark } from "prosemirror-commands";
import { applyDarkModeFilter, THEME } from "@excalidraw/common";
import {
  getContainerElement,
  getBoundTextMaxWidth,
  getTextElementAngle,
  getBoundTextElementId,
} from "@excalidraw/element";
import {
  isRichTextV1,
  normalizeRichText,
  richTextFromPlainText,
  richTextPlainText,
} from "../lib/element/src/richTextDocument";
import { richTextBlockStyle } from "../lib/element/src/richTextLayout";
import type { RichTextV1 } from "../lib/element/src/richTextDocument";
import type { textWysiwyg } from "./textWysiwyg";

export const richTextWysiwyg = (
  options: Parameters<typeof textWysiwyg>[0],
): ((cancelled?: boolean) => void) => {
  const {
    app,
    element,
    excalidrawContainer,
    onChange,
    onSubmit,
    getViewportCoords,
    canvas,
    autoSelect = true,
    initialCaretSceneCoords,
  } = options;
  const ownerDocument = excalidrawContainer?.ownerDocument ?? document;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const box = excalidrawContainer?.querySelector<HTMLElement>(
    ".excalidraw-textEditorContainer",
  );

  if (!box) throw new Error("Missing canvas text editor container");
  const mount = ownerDocument.createElement("div");

  mount.className = "excalidraw-richTextMount";
  box.append(mount);
  let destroyed = false;
  let localUpdate = false;
  let viaKeyboard = false;
  const initial = isRichTextV1(element.richText)
    ? element.richText
    : richTextFromPlainText(element.originalText);
  let richActivated = !!element.richText;
  const persisted = (richText: RichTextV1) => {
    if (
      richText.doc.content[0].content?.some(
        (node) => node.type === "text" && node.marks?.length,
      )
    )
      richActivated = true;

    // Once activated, clearing all marks still publishes an authoritative plain document.
    // An undefined update alone can otherwise be ignored when font metrics do not change.
    return richActivated ? richText : undefined;
  };
  const documentValue = (): RichTextV1 =>
    normalizeRichText({ version: 1, doc: view.state.doc.toJSON() });
  const publish = () => {
    const richText = documentValue();

    localUpdate = true;
    try {
      onChange?.(richTextPlainText(richText), persisted(richText));
    } finally {
      localUpdate = false;
    }
  };
  const submit = (cancelled: unknown = false) => {
    if (destroyed) return;
    const richText = documentValue();

    destroyed = true;
    unsubscribe();
    unscroll();
    observer.disconnect();
    ownerWindow.removeEventListener("pointerdown", outside, true);
    ownerWindow.removeEventListener("beforeunload", submit);
    ownerWindow.removeEventListener("blur", submit);
    box.removeEventListener("scroll", followCaret);
    box.style.removeProperty("left");
    box.style.removeProperty("right");
    view.destroy();
    mount.remove();
    const latest = app.scene.getNonDeletedElement(element.id);

    if (cancelled !== true && latest && latest.type === "text") {
      const container = getContainerElement(
        latest,
        app.scene.getNonDeletedElementsMap(),
      );

      if (
        container &&
        richTextPlainText(richText).trim() &&
        getBoundTextElementId(container) !== element.id
      ) {
        app.scene.mutateElement(container, {
          boundElements: [
            ...(container.boundElements ?? []),
            { type: "text", id: element.id },
          ],
        });
      }
    }

    onSubmit({
      viaKeyboard,
      nextOriginalText: richTextPlainText(richText),
      richText: persisted(richText),
      cancelled: cancelled === true,
    });
  };
  const hardBreak: Command = (state, dispatch) => {
    if (dispatch)
      dispatch(
        state.tr
          .replaceSelectionWith(richTextSchema.nodes.hardBreak.create())
          .scrollIntoView(),
      );

    return true;
  };
  const clearMarks: Command = (state, dispatch) => {
    if (dispatch)
      dispatch(
        state.tr
          .removeMark(state.selection.from, state.selection.to)
          .setStoredMarks([]),
      );

    return true;
  };
  const finish: Command = () => {
    viaKeyboard = true;
    submit();

    return true;
  };
  const view = new EditorView(mount, {
    state: EditorState.create({
      schema: richTextSchema,
      doc: richTextSchema.nodeFromJSON(initial.doc),
      plugins: [
        richTextInputRules(),
        keymap({
          Enter: hardBreak,
          "Shift-Enter": hardBreak,
          Escape: finish,
          "Mod-Enter": finish,
          Backspace: undoInputRule,
          "Mod-z": chainCommands(undoInputRule, undo),
          "Mod-Shift-z": redo,
          "Mod-y": redo,
          "Mod-b": toggleMark(richTextSchema.marks.bold),
          "Mod-i": toggleMark(richTextSchema.marks.italic),
          "Mod-e": toggleMark(richTextSchema.marks.code),
          "Mod-\\": clearMarks,
          Tab: (state, dispatch) => {
            if (dispatch) dispatch(state.tr.insertText("    "));

            return true;
          },
        }),
        history(),
        keymap(baseKeymap),
      ],
    }),
    attributes: {
      class: "excalidraw-wysiwyg excalidraw-richText",
      "data-type": "wysiwyg",
      "aria-label": "画布文字",
      role: "textbox",
      "aria-multiline": "true",
      spellcheck: "false",
      dir: "auto",
    },
    dispatchTransaction(transaction) {
      if (destroyed) return;
      view.updateState(view.state.apply(transaction));
      if (transaction.docChanged) publish();
      updateStyle();
    },
    // Plain text paste deliberately bypasses Markdown/HTML rules and external resource loading.
    handlePaste(_view, event) {
      const text = event.clipboardData?.getData("text/plain");

      if (text === undefined) return false;
      const doc = richTextSchema.nodeFromJSON(richTextFromPlainText(text).doc);

      view.dispatch(
        view.state.tr
          .replaceSelection(
            new Slice(Fragment.from(doc.firstChild!.content), 0, 0),
          )
          .scrollIntoView(),
      );

      return true;
    },
    handleDOMEvents: {
      keydown(_view, event) {
        if (!event.isComposing) event.stopPropagation();

        return false;
      },
      pointerdown(_view, event) {
        event.stopPropagation();

        return false;
      },
      blur() {
        ownerWindow.setTimeout(() => {
          if (
            !destroyed &&
            !ownerDocument.activeElement?.closest(
              ".shape-actions-menu, .compact-shape-actions-island, .properties-content",
            )
          )
            submit();
        }, 0);

        return false;
      },
    },
  });
  const updateStyle = () => {
    if (destroyed) return;
    const latest = app.scene.getNonDeletedElement(element.id);

    if (!latest || latest.type !== "text") return;
    const container = getContainerElement(
      latest,
      app.scene.getNonDeletedElementsMap(),
    );
    const { left, right } = app.viewport.getSidebarInsets();

    box.style.left = `${left}px`;
    box.style.right = `${right}px`;
    const [x, y] = getViewportCoords(latest.x, latest.y);
    const angle = getTextElementAngle(latest, container);
    const zoom = app.state.zoom.value;
    const width = container
      ? getBoundTextMaxWidth(container, latest)
      : latest.autoResize
        ? Infinity
        : latest.width;

    Object.assign(view.dom.style, richTextBlockStyle(latest, width), {
      position: "absolute",
      minWidth: "1px",
      minHeight: `${latest.fontSize * latest.lineHeight}px`,
      left: `${x - left}px`,
      top: `${y}px`,
      background: "transparent",
      zIndex: "var(--zIndex-wysiwyg)",
      color: applyDarkModeFilter(
        latest.strokeColor,
        app.state.theme === THEME.DARK,
      ),
      opacity: String(latest.opacity / 100),
      transformOrigin: `${latest.width / 2}px ${latest.height / 2}px`,
      transform: `translate(${(latest.width * (zoom - 1)) / 2}px, ${(latest.height * (zoom - 1)) / 2}px) scale(${zoom}) rotate(${angle}rad)`,
    });
    Object.assign((view.dom.firstChild as HTMLElement).style, {
      margin: "0",
      padding: "0",
      font: "inherit",
      lineHeight: "inherit",
      whiteSpace: "inherit",
    });
  };
  const followCaret = () => {
    const { scrollLeft, scrollTop } = box;

    if (!scrollLeft && !scrollTop) return;
    box.scrollLeft = 0;
    box.scrollTop = 0;
    app.viewport.translate((state) => ({
      scrollX: state.scrollX - scrollLeft / state.zoom.value,
      scrollY: state.scrollY - scrollTop / state.zoom.value,
    }));
  };
  const outside = (event: PointerEvent) => {
    if (destroyed || mount.contains(event.target as Node)) return;
    const target = event.target as HTMLElement;

    if (
      target.closest?.(
        ".shape-actions-menu, .compact-shape-actions-island, .properties-content, .zoom-actions",
      )
    )
      return;
    submit();
  };
  const unsubscribe = app.scene.onUpdate(() => {
    if (!localUpdate) updateStyle();
  });
  const unscroll = app.onScrollChangeEmitter.on(updateStyle);
  const observer = new ResizeObserver(updateStyle);

  observer.observe(canvas);
  box.addEventListener("scroll", followCaret);
  ownerWindow.addEventListener("beforeunload", submit);
  ownerWindow.addEventListener("blur", submit);
  updateStyle();
  // Defer beyond the pointer event that opened the editor.
  ownerWindow.requestAnimationFrame(() => {
    if (destroyed) return;
    ownerWindow.addEventListener("pointerdown", outside, true);
    view.focus();
    const position = initialCaretSceneCoords
      ? view.posAtCoords({
          left:
            getViewportCoords(
              initialCaretSceneCoords.x,
              initialCaretSceneCoords.y,
            )[0] + app.state.offsetLeft,
          top:
            getViewportCoords(
              initialCaretSceneCoords.x,
              initialCaretSceneCoords.y,
            )[1] + app.state.offsetTop,
        })?.pos
      : null;

    if (position != null)
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, position),
        ),
      );
    else if (autoSelect)
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(
            view.state.doc,
            1,
            view.state.doc.content.size - 1,
          ),
        ),
      );
  });

  return submit;
};
