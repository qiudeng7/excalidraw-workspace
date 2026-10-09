import { actionClearCanvas } from "../actions";
import { atom, useAtom } from "../editor-jotai";
import { t } from "../i18n";
import { libraryImportConfirmationAtom } from "../data/library";

import { useExcalidrawActionManager } from "./App";
import ConfirmDialog from "./ConfirmDialog";

export const activeConfirmDialogAtom = atom<"clearCanvas" | null>(null);

export const ActiveConfirmDialog = () => {
  const [libraryImportConfirmation] = useAtom(libraryImportConfirmationAtom);
  const [activeConfirmDialog, setActiveConfirmDialog] = useAtom(
    activeConfirmDialogAtom,
  );
  const actionManager = useExcalidrawActionManager();

  if (libraryImportConfirmation) {
    return (
      <ConfirmDialog
        onConfirm={() => libraryImportConfirmation.complete(true)}
        onCancel={() => libraryImportConfirmation.complete(false)}
        title={t("toolBar.library")}
      >
        <p>{libraryImportConfirmation.message}</p>
      </ConfirmDialog>
    );
  }

  if (!activeConfirmDialog) {
    return null;
  }

  if (activeConfirmDialog === "clearCanvas") {
    return (
      <ConfirmDialog
        onConfirm={() => {
          actionManager.executeAction(actionClearCanvas);
          setActiveConfirmDialog(null);
        }}
        onCancel={() => setActiveConfirmDialog(null)}
        title={t("clearCanvasDialog.title")}
      >
        <p className="clear-canvas__content"> {t("alerts.clearReset")}</p>
      </ConfirmDialog>
    );
  }

  return null;
};
