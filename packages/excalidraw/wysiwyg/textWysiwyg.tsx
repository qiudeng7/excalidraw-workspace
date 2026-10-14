import type { ExcalidrawTextElement } from "@excalidraw/element/types";
import { richTextWysiwyg } from "./richTextWysiwyg";
import type { SupportedRichText } from "../lib/element/src/richTextDocument";
import type App from "../components/App";

export const CARET_FOLLOW_PADDING = 5;

export type TextWysiwygOptions = {
  onChange?: (nextOriginalText: string, richText?: SupportedRichText) => void;
  onSubmit: (data: {
    viaKeyboard: boolean;
    nextOriginalText: string;
    richText?: SupportedRichText;
    cancelled?: boolean;
  }) => void;
  getViewportCoords: (x: number, y: number) => [number, number];
  element: ExcalidrawTextElement;
  canvas: HTMLCanvasElement;
  excalidrawContainer: HTMLDivElement | null;
  app: App;
  autoSelect?: boolean;
  initialCaretSceneCoords?: { x: number; y: number } | null;
};

/** Cancel destroys the editing history without publishing another element update. */
export const textWysiwyg = (
  options: TextWysiwygOptions,
): ((cancelled?: boolean) => void) => richTextWysiwyg(options);
