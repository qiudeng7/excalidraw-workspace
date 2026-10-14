import type { AppState } from "@excalidraw/excalidraw/types";

type DeviceNavigator = Pick<Navigator, "userAgent" | "maxTouchPoints">;

/** UA chooses the initial tool only; touch-enabled desktops keep their usual default. */
export function defaultEditorTool(
  device: DeviceNavigator,
): AppState["activeTool"] {
  const mobile =
    /Android|iPhone|iPad|iPod|Mobile/i.test(device.userAgent) ||
    (/Macintosh/i.test(device.userAgent) && device.maxTouchPoints > 1);

  return {
    type: mobile ? "hand" : "selection",
    customType: null,
    locked: false,
    fromSelection: false,
    lastActiveTool: null,
  };
}
