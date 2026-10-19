import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/element/types";
import type { BinaryFiles } from "./types";
import {
  isSupportedRichText,
  isSafeRichTextLink,
  richTextPlainText,
  type RichTextBlock,
  type RichTextV2Inline,
} from "./lib/element/src/richTextDocument";

/** HTML is both a visible document and an optional, versioned native transport. */
export const SMART_CLIPBOARD_ATTRIBUTE = "data-excalidraw-workspace";

export const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024;

export const MAX_CLIPBOARD_HTML = MAX_CLIPBOARD_BYTES * 3;
const PAYLOAD_TYPE = "excalidraw-workspace/clipboard";
const elementTypes = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "line",
  "arrow",
  "freedraw",
  "text",
  "image",
  "frame",
  "magicframe",
  "embeddable",
  "iframe",
  "stickynote",
]);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const escapeClipboardHTML = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

export function getSemanticClipboardText(
  elements: readonly ExcalidrawElement[],
) {
  const seen = new Set<string>();

  return elements
    .filter((element): element is ExcalidrawTextElement => {
      if (element.isDeleted || element.type !== "text" || seen.has(element.id))
        return false;
      seen.add(element.id);

      return true;
    })
    .map((element) =>
      isSupportedRichText(element.richText)
        ? richTextPlainText(element.richText)
        : (element.originalText ?? element.text),
    )
    .join("\n\n");
}

/** Reject poison keys, non-finite geometry and pathological nesting before restoration. */
function safeTree(
  value: unknown,
  depth = 0,
  budget = { left: 250000 },
): boolean {
  if (--budget.left < 0 || depth > 64) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return true;

  return Object.entries(value).every(
    ([key, item]) =>
      !["__proto__", "prototype", "constructor"].includes(key) &&
      safeTree(item, depth + 1, budget),
  );
}

export function validateNativeClipboard(value: unknown): value is {
  type: "excalidraw/clipboard";
  elements: ExcalidrawElement[];
  files?: BinaryFiles;
} {
  if (
    !object(value) ||
    value.type !== "excalidraw/clipboard" ||
    !Array.isArray(value.elements) ||
    value.elements.length > 10000 ||
    !safeTree(value)
  )
    return false;
  const ids = new Set<string>();

  for (const element of value.elements) {
    if (
      !object(element) ||
      typeof element.id !== "string" ||
      !element.id ||
      ids.has(element.id) ||
      !elementTypes.has(String(element.type)) ||
      !["x", "y", "width", "height", "angle", "version", "versionNonce"].every(
        (key) =>
          typeof element[key] === "number" && Number.isFinite(element[key]),
      ) ||
      !Array.isArray(element.groupIds) ||
      element.groupIds.some((id) => typeof id !== "string") ||
      (element.type === "text" &&
        (typeof element.text !== "string" ||
          typeof element.originalText !== "string" ||
          (element.richText !== undefined &&
            !isSupportedRichText(element.richText))))
    )
      return false;
    const optionalStrings = [
      "link",
      "name",
      "strokeColor",
      "backgroundColor",
      "fillStyle",
      "strokeStyle",
      "index",
      "textAlign",
      "verticalAlign",
      "status",
      "startArrowhead",
      "endArrowhead",
    ];
    const optionalNumbers = [
      "seed",
      "strokeWidth",
      "roughness",
      "opacity",
      "updated",
      "created",
      "lineHeight",
      "baseHeight",
      "fontSize",
      "fontFamily",
    ];

    if (
      optionalStrings.some(
        (key) => element[key] != null && typeof element[key] !== "string",
      ) ||
      optionalNumbers.some(
        (key) =>
          element[key] != null &&
          (typeof element[key] !== "number" || !Number.isFinite(element[key])),
      ) ||
      (Object.hasOwn(element, "font") && typeof element.font !== "string") ||
      (element.boundElementIds != null &&
        (!Array.isArray(element.boundElementIds) ||
          element.boundElementIds.some((id) => typeof id !== "string"))) ||
      element.isDeleted === true ||
      (element.type === "freedraw" &&
        element.pressures != null &&
        (!Array.isArray(element.pressures) ||
          element.pressures.some(
            (pressure) =>
              typeof pressure !== "number" || !Number.isFinite(pressure),
          ))) ||
      (element.type === "image" &&
        element.scale != null &&
        (!Array.isArray(element.scale) ||
          element.scale.length !== 2 ||
          element.scale.some(
            (scale) => typeof scale !== "number" || !Number.isFinite(scale),
          )))
    )
      return false;
    if (
      element.id.length > 200 ||
      ["__proto__", "prototype", "constructor"].includes(element.id) ||
      !Number.isSafeInteger(element.version) ||
      Number(element.version) < 1 ||
      !Number.isSafeInteger(element.versionNonce) ||
      Number(element.versionNonce) < 0 ||
      ["x", "y", "width", "height"].some(
        (key) => Math.abs(Number(element[key])) > 1e9,
      ) ||
      (element.boundElements !== null &&
        element.boundElements !== undefined &&
        (!Array.isArray(element.boundElements) ||
          element.boundElements.some(
            (bound) =>
              !object(bound) ||
              typeof bound.id !== "string" ||
              !["text", "arrow"].includes(String(bound.type)),
          ))) ||
      ["frameId", "containerId"].some(
        (key) => element[key] != null && typeof element[key] !== "string",
      )
    )
      return false;
    if (
      ["arrow", "line", "freedraw"].includes(String(element.type)) &&
      (!Array.isArray(element.points) ||
        element.points.length > 100000 ||
        element.points.some(
          (point) =>
            !Array.isArray(point) ||
            point.length !== 2 ||
            point.some(
              (number) =>
                typeof number !== "number" || !Number.isFinite(number),
            ),
        ))
    )
      return false;
    if (
      element.type === "text" &&
      (!Number.isFinite(element.fontSize) ||
        Number(element.fontSize) <= 0 ||
        (element.lineHeight != null && Number(element.lineHeight) <= 0) ||
        !Number.isFinite(element.fontFamily) ||
        typeof element.strokeColor !== "string" ||
        typeof element.textAlign !== "string")
    )
      return false;
    if (
      ["startBinding", "endBinding"].some(
        (key) =>
          element[key] != null &&
          (!object(element[key]) || typeof element[key].elementId !== "string"),
      )
    )
      return false;
    ids.add(element.id);
  }

  if (value.files !== undefined) {
    if (!object(value.files) || Object.keys(value.files).length > 1000)
      return false;
    for (const [id, file] of Object.entries(value.files)) {
      if (
        !object(file) ||
        file.id !== id ||
        typeof file.dataURL !== "string" ||
        !/^data:image\/(png|jpeg|gif|webp|svg\+xml|bmp|x-icon|avif);base64,/i.test(
          file.dataURL,
        ) ||
        typeof file.mimeType !== "string" ||
        !file.mimeType.startsWith("image/") ||
        typeof file.created !== "number"
      )
        return false;
    }
  }

  return value.elements.every(
    (element) =>
      element.type !== "image" ||
      !element.fileId ||
      (object(value.files) &&
        Object.hasOwn(value.files, String(element.fileId))),
  );
}

export function encodeNativeClipboard(json: string) {
  if (new TextEncoder().encode(json).length > MAX_CLIPBOARD_BYTES)
    throw new Error("复制内容超过 16 MiB，请减少所选元素或图片。");
  const native: unknown = JSON.parse(json);

  if (!validateNativeClipboard(native))
    throw new Error("无法完整复制所选元素：数据或引用图片不完整。");
  const bytes = new TextEncoder().encode(
    JSON.stringify({ type: PAYLOAD_TYPE, version: 1, data: native }),
  );
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary);
}

export function readNativeClipboardHTML(html: string) {
  if (!html || html.length > MAX_CLIPBOARD_HTML) return null;
  // Read only our inert base64 attribute, never insert untrusted HTML into the live document.
  const match = html.match(
    /\bdata-excalidraw-workspace\s*=\s*["']([A-Za-z0-9+/=]+)["']/i,
  );

  if (
    !match ||
    match[1].length > Math.ceil(((MAX_CLIPBOARD_BYTES + 256) * 4) / 3)
  )
    return null;
  try {
    const bytes = Uint8Array.from(atob(match[1]), (char) => char.charCodeAt(0));

    if (bytes.byteLength > MAX_CLIPBOARD_BYTES + 256) return null;
    const envelope: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );

    return object(envelope) &&
      envelope.type === PAYLOAD_TYPE &&
      envelope.version === 1 &&
      validateNativeClipboard(envelope.data)
      ? envelope.data
      : null;
  } catch (error) {
    console.debug(
      "Invalid native clipboard marker; using external paste",
      error,
    );

    return null;
  }
}

function renderNode(node: RichTextBlock | RichTextV2Inline): string {
  if (node.type === "hardBreak") return "<br>";
  if (node.type === "text") {
    let text = escapeClipboardHTML(node.text);

    for (const mark of node.marks ?? []) {
      const tags = {
        bold: "strong",
        italic: "em",
        code: "code",
        strike: "s",
        highlight: "mark",
      };

      if (mark.type === "link") {
        if (
          isSafeRichTextLink(mark.attrs.href) &&
          /^(https?:\/\/|mailto:|tel:)/i.test(mark.attrs.href)
        )
          text = `<a href="${escapeClipboardHTML(mark.attrs.href)}">${text}</a>`;
      } else {
        const tag = tags[mark.type];

        text = `<${tag}>${text}</${tag}>`;
      }
    }

    return text;
  }

  const tags = {
    paragraph: "p",
    heading: "h",
    codeBlock: "pre",
    blockquote: "blockquote",
    bulletList: "ul",
    orderedList: "ol",
    listItem: "li",
  };
  const tag =
    node.type === "heading" ? `h${node.attrs.level}` : tags[node.type];
  const attrs =
    node.type === "orderedList" ? ` start="${node.attrs?.order ?? 1}"` : "";

  return `<${tag}${attrs}>${(node.content ?? []).map(renderNode).join("")}</${tag}>`;
}

export function renderClipboardText(element: ExcalidrawTextElement) {
  const text = isSupportedRichText(element.richText)
    ? element.richText.doc.content.map(renderNode).join("")
    : `<p>${escapeClipboardHTML(element.originalText ?? element.text).replace(/\r?\n/g, "<br>")}</p>`;
  const color = /^#[0-9a-f]{3,8}$/i.test(element.strokeColor)
    ? element.strokeColor
    : "#000000";
  const fonts: Record<number, string> = {
    2: "Arial, sans-serif",
    3: "monospace",
    6: "Nunito, sans-serif",
  };
  const size = Number.isFinite(element.fontSize)
    ? Math.max(1, Math.min(512, element.fontSize))
    : 20;
  const align = ["left", "center", "right"].includes(element.textAlign)
    ? element.textAlign
    : "left";

  return `<div style="font-family:${fonts[element.fontFamily] ?? "sans-serif"};font-size:${size}px;color:${color};text-align:${align};white-space:pre-wrap">${text}</div>`;
}

export function createClipboardHTML(
  encoded: string,
  elements: readonly ExcalidrawElement[],
  graphic?: string,
) {
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded))
    throw new Error("剪贴板标记编码无效。");
  const seen = new Set<string>();
  const text = elements
    .filter((element): element is ExcalidrawTextElement => {
      if (element.isDeleted || element.type !== "text" || seen.has(element.id))
        return false;
      seen.add(element.id);

      return true;
    })
    .map(renderClipboardText)
    .join("");

  if (graphic && !graphic.startsWith("data:image/png;base64,"))
    throw new Error("剪贴板图像必须是内嵌 PNG。");
  const html = `<div ${SMART_CLIPBOARD_ATTRIBUTE}="${encoded}">${graphic ? `<p><img alt="" src="${escapeClipboardHTML(graphic)}" style="max-width:100%;height:auto"></p>` : ""}${text}</div>`;

  if (html.length > MAX_CLIPBOARD_HTML)
    throw new Error("复制的图文超过容量限制，请减少所选内容。");

  return html;
}

let operation = 0;

export const beginClipboardOperation = () => ++operation;

export const isCurrentClipboardOperation = (token: number) =>
  token === operation;

export type SmartClipboardWriteResult = { complete: boolean; current: boolean };

/** Invoke write synchronously with promised representations: Safari must see the user gesture. */
export function writeSmartClipboard({
  plain,
  html,
  fallbackHTML,
  event,
  token,
}: {
  plain: string;
  html: Promise<string>;
  fallbackHTML: string;
  event?: ClipboardEvent | null;
  token: number;
}): Promise<SmartClipboardWriteResult> {
  const checkedHTML = html.then((value) => {
    if (!isCurrentClipboardOperation(token))
      throw new Error("复制已被后续操作取代。");

    return new Blob([value], { type: "text/html" });
  });

  // Consume rendering errors even on browsers without Async Clipboard.
  checkedHTML.catch(() => undefined);
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      return navigator.clipboard
        .write([
          new ClipboardItem({
            "text/html": checkedHTML,
            "text/plain": Promise.resolve(
              new Blob([plain], { type: "text/plain" }),
            ),
          }),
        ])
        .catch(async (error: unknown) => {
          // Some engines expose ClipboardItem but reject promised representations.
          // Do not retry permission denial or a superseded operation.
          if (
            !isCurrentClipboardOperation(token) ||
            !(error instanceof Error) ||
            !["TypeError", "NotSupportedError"].includes(error.name)
          )
            throw error;
          const resolvedHTML = await checkedHTML;

          if (!isCurrentClipboardOperation(token)) throw error;
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/html": resolvedHTML,
              "text/plain": new Blob([plain], { type: "text/plain" }),
            }),
          ]);
        })
        .then(() => ({
          complete: true,
          current: isCurrentClipboardOperation(token),
        }));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // Event fallback retains native data, but cannot wait for a graphic preview.
  if (event?.clipboardData) {
    try {
      event.clipboardData.setData("text/plain", plain);
      event.clipboardData.setData("text/html", fallbackHTML);

      return Promise.resolve({
        complete: false,
        current: isCurrentClipboardOperation(token),
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(plain).then(() => ({
      complete: false,
      current: isCurrentClipboardOperation(token),
    }));
  }

  return Promise.reject(
    new Error("浏览器不支持智能图文复制，请使用安全上下文并允许剪贴板写入。"),
  );
}
