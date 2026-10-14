import {
  richTextSchema,
  richTextInputRules,
  parseRichTextMarkdown,
  richTextKeymapCommands,
} from "./richTextEditor";
import { Slice, Fragment } from "prosemirror-model";
import {
  EditorState,
  TextSelection,
  AllSelection,
  type Command,
} from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo, redo } from "prosemirror-history";
import { undoInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import {
  baseKeymap,
  chainCommands,
  toggleMark,
  newlineInCode,
} from "prosemirror-commands";
import { applyDarkModeFilter, THEME } from "@excalidraw/common";
import {
  getContainerElement,
  LinearElementEditor,
  computeBoundTextPosition,
  getBoundTextMaxHeight,
  computeContainerDimensionForBoundText,
  isArrowElement,
  isStickyNoteElement,
  originalContainerCache,
  updateOriginalContainerCache,
  updateBoundElements,
  getTextElementAngle,
  getBoundTextElementId,
} from "@excalidraw/element";
import {
  isSupportedRichText,
  normalizeRichText,
  richTextFromPlainText,
  richTextPlainText,
} from "../lib/element/src/richTextDocument";
import { applyRichTextDocumentStyle } from "../lib/element/src/richTextLayout";
import type { SupportedRichText } from "../lib/element/src/richTextDocument";
import type {
  ExcalidrawTextElementWithContainer,
  ExcalidrawTextElement,
  ExcalidrawTextContainer,
  NonDeleted,
} from "@excalidraw/element/types";
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
  const initial = isSupportedRichText(element.richText)
    ? element.richText
    : richTextFromPlainText(element.originalText);
  let edited = false;
  let plainPaste = false;
  let styling = false;
  // Opening and closing a legacy element never migrates its persisted document.
  const persisted = (richText: SupportedRichText) =>
    edited ? richText : (element.richText as SupportedRichText | undefined);
  const documentValue = (): SupportedRichText =>
    edited
      ? normalizeRichText({ version: 2, doc: view.state.doc.toJSON() })
      : initial;
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
          ...richTextKeymapCommands,
          "Shift-Enter": chainCommands(newlineInCode, hardBreak),
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
          Tab: chainCommands(richTextKeymapCommands.Tab, (state, dispatch) => {
            if (dispatch) dispatch(state.tr.insertText("    "));

            return true;
          }),
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
      if (transaction.docChanged) {
        edited = true;
        publish();
      }

      updateStyle();
    },
    // Only explicit plain paste and code blocks bypass Markdown parsing.
    handlePaste(_view, event) {
      const text = event.clipboardData?.getData("text/plain");

      if (text === undefined) return false;
      const literal =
        plainPaste || view.state.selection.$from.parent.type.spec.code;

      plainPaste = false;
      if (view.state.selection.$from.parent.type.spec.code) {
        view.dispatch(view.state.tr.insertText(text).scrollIntoView());
      } else {
        const doc = literal
          ? richTextSchema.nodeFromJSON(richTextFromPlainText(text).doc)
          : parseRichTextMarkdown(text);

        view.dispatch(
          view.state.tr
            .replaceSelection(
              literal
                ? new Slice(Fragment.from(doc.firstChild!.content), 0, 0)
                : Slice.maxOpen(doc.content),
            )
            .scrollIntoView(),
        );
      }

      return true;
    },
    handleDOMEvents: {
      keydown(_view, event) {
        plainPaste =
          event.key.toLowerCase() === "v" &&
          event.shiftKey &&
          (event.ctrlKey || event.metaKey);
        event.stopPropagation();

        return false;
      },
      click(_view, event) {
        if ((event.target as Element).closest("a")) event.preventDefault();

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
    if (destroyed || styling) return;
    const latest = app.scene.getNonDeletedElement(element.id);

    if (!latest || latest.type !== "text") return;
    const container = getContainerElement<
      NonDeleted<ExcalidrawTextElement>,
      NonDeleted<ExcalidrawTextContainer>
    >(latest, app.scene.getNonDeletedElementsMap());
    const { left, right } = app.viewport.getSidebarInsets();

    box.style.left = `${left}px`;
    box.style.right = `${right}px`;
    styling = true;
    try {
      const elementsMap = app.scene.getNonDeletedElementsMap();
      let coordX = latest.x;
      let coordY = latest.y;

      if (container && latest.containerId) {
        const boundText = latest as ExcalidrawTextElementWithContainer;

        if (!isArrowElement(container) && !isStickyNoteElement(container)) {
          const original =
            originalContainerCache[container.id] ??
            updateOriginalContainerCache(container.id, container.height);
          const maxHeight = getBoundTextMaxHeight(container, boundText);

          if (
            latest.height > maxHeight ||
            (container.height > original.height && latest.height < maxHeight)
          ) {
            const height = Math.max(
              original.height,
              computeContainerDimensionForBoundText(
                latest.height,
                container.type,
              ),
            );

            if (height !== container.height) {
              app.scene.mutateElement(container, { height });
              updateBoundElements(container, app.scene);
            }
          }
        }

        const position = isArrowElement(container)
          ? LinearElementEditor.getBoundTextElementPosition(
              container,
              boundText,
              elementsMap,
            )
          : computeBoundTextPosition(container, boundText, elementsMap);

        coordX = position.x;
        coordY = position.y;
      }

      const [x, y] = getViewportCoords(coordX, coordY);
      const angle = getTextElementAngle(latest, container);
      const zoom = app.state.zoom.value;

      // The canvas aligns text inside its measured element box, not the container's capacity.
      applyRichTextDocumentStyle(view.dom, latest, latest.width);
      Object.assign(view.dom.style, {
        position: "absolute",
        minWidth: "1px",
        pointerEvents: "auto",
        boxSizing: "content-box",
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
      if (latest.x !== coordX || latest.y !== coordY)
        app.scene.mutateElement(latest, { x: coordX, y: coordY });
    } finally {
      styling = false;
    }
  };
  const followCaret = () => {
    const { scrollLeft, scrollTop } = box;

    if (!scrollLeft && !scrollTop) return;
    box.scrollLeft = 0;
    box.scrollTop = 0;
    app.viewport.translate((state) => ({
      scrollX:
        state.scrollX - (scrollLeft && scrollLeft + 5) / state.zoom.value,
      scrollY: state.scrollY - (scrollTop && scrollTop + 5) / state.zoom.value,
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
        view.state.tr.setSelection(new AllSelection(view.state.doc)),
      );
  });

  return submit;
};
