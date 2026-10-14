import { isRichTextV1 } from "@excalidraw/excalidraw/rich-text";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/** Stable across reloads; isolated by account, capability and browser tab. */
export async function richTextRecoveryStorageKey(
  options: { canvasId: string; userId?: string; token?: string },
  tabId: string,
) {
  const tokenHash = options.token
    ? Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(options.token),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("")
    : "";

  return JSON.stringify([
    "excalidraw-rich-text-recovery",
    1,
    options.userId ?? "guest",
    options.canvasId,
    tokenHash,
    tabId,
  ]);
}

export function writeRichTextRecovery(
  key: string,
  source: ExcalidrawElement,
  storage?: Pick<Storage, "setItem">,
): boolean {
  if (!key) return false;
  try {
    (storage ?? localStorage).setItem(key, JSON.stringify(source));

    return true;
  } catch (cause) {
    console.warn("富文本恢复副本尚未写入浏览器，请刷新前下载", cause);

    return false;
  }
}

export function readRichTextRecovery(
  key: string,
  storage?: Pick<Storage, "getItem">,
): ExcalidrawElement | undefined {
  // The browser quota decides what can be stored. Do not hide successfully
  // persisted documents behind a smaller, unrelated serialized-length limit.
  const raw = (storage ?? localStorage).getItem(key);
  const saved = raw ? JSON.parse(raw) : undefined;

  return saved?.type === "text" && isRichTextV1(saved.richText)
    ? saved
    : undefined;
}

/** Export local data only; this never captures an editor or calls the room. */
export async function downloadRichTextRecovery(
  source: ExcalidrawElement,
  name = "画布",
) {
  if (source.type !== "text") return;
  const { serializeAsJSON } = await import("@excalidraw/excalidraw");
  const content = serializeAsJSON(
    [
      {
        ...source,
        containerId: null,
        boundElements: null,
        groupIds: [],
        frameId: null,
        autoResize: false,
        isDeleted: false,
      },
    ],
    { viewBackgroundColor: "#ffffff" },
    {},
    "local",
  );
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  const link = document.createElement("a");

  link.href = url;
  link.download = `${name}-文字恢复副本.excalidraw`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
