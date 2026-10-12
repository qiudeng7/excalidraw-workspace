import type { Element, SharedScene } from "./types";
import {
  shouldDiscardRemoteElement,
  reconcileElementVersions,
  orderByFractionalIndex,
  fractionalIndexUpdates,
} from "@excalidraw/excalidraw/reconcile";

/** Canonical JSON also rejects ambiguous same-version payloads with reordered keys. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;

  return JSON.stringify(value);
}

export class CollaborationError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function reject(code: string, message: string, status = 400): never {
  throw new CollaborationError(code, message, status);
}

export function validateElement(value: unknown): asserts value is Element {
  const element = value as Element;
  const types = [
    "rectangle",
    "diamond",
    "ellipse",
    "arrow",
    "line",
    "freedraw",
    "text",
    "image",
    "frame",
    "magicframe",
    "embeddable",
    "iframe",
  ];

  if (
    !element ||
    typeof element !== "object" ||
    Array.isArray(element) ||
    typeof element.id !== "string" ||
    !element.id ||
    element.id.length > 200 ||
    ["__proto__", "constructor", "prototype"].includes(element.id) ||
    !types.includes(String(element.type)) ||
    ["x", "y", "width", "height", "angle"].some(
      (key) =>
        typeof element[key] !== "number" ||
        !Number.isFinite(element[key]) ||
        Math.abs(element[key] as number) > 1e9,
    ) ||
    !Number.isSafeInteger(element.version) ||
    element.version < 1 ||
    !Number.isSafeInteger(element.versionNonce) ||
    element.versionNonce < 0 ||
    (element.index !== undefined &&
      (typeof element.index !== "string" || element.index.length > 256)) ||
    (element.isDeleted !== undefined && typeof element.isDeleted !== "boolean")
  )
    reject("INVALID_ELEMENT", "画布元素格式无效");
  if (
    ["arrow", "line", "freedraw"].includes(String(element.type)) &&
    (!Array.isArray(element.points) ||
      element.points.length > 100000 ||
      element.points.some(
        (point) =>
          !Array.isArray(point) ||
          point.length !== 2 ||
          point.some(
            (coordinate) =>
              typeof coordinate !== "number" || !Number.isFinite(coordinate),
          ),
      ))
  )
    reject("INVALID_ELEMENT", "线条坐标无效");
  if (
    element.type === "text" &&
    (typeof element.text !== "string" || element.text.length > 1000000)
  )
    reject("INVALID_ELEMENT", "文本内容无效");
}

/** Excalidraw's deterministic version/nonce winner, without its local active-edit guard. */
export function wins(incoming: Element, existing: Element): boolean {
  return !shouldDiscardRemoteElement({}, existing, incoming);
}

export function orderElements(elements: Iterable<Element>): Element[] {
  return orderByFractionalIndex([...elements]);
}

/** Use the editor's index repairs; only the authority issues versioned repairs. */
export function repairOrder(elements: Element[]): Element[] {
  const ordered = orderElements(elements);
  const updates = fractionalIndexUpdates(ordered);

  return ordered.map((element) => {
    const repair = updates.get(element);

    return repair
      ? {
          ...element,
          index: repair.index,
          version: element.version + 1,
          versionNonce: 0,
        }
      : element;
  });
}

export function mergeElements(scene: SharedScene, incoming: Element[]) {
  const elements = new Map(
    scene.elements.map((element) => [element.id, element]),
  );
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const value of incoming) {
    validateElement(value);
    if (seen.has(value.id)) reject("DUPLICATE_ELEMENT", "同一操作包含重复元素");
    seen.add(value.id);
    const existing = elements.get(value.id);

    if (
      existing &&
      existing.version === value.version &&
      existing.versionNonce === value.versionNonce &&
      canonical(existing) !== canonical(value)
    )
      reject("ELEMENT_VERSION_REUSED", "相同元素版本不能对应不同内容");
    if (!existing || wins(value, existing)) {
      if (
        value.type === "image" &&
        !value.isDeleted &&
        (typeof value.fileId !== "string" ||
          !Object.hasOwn(scene.files, value.fileId))
      )
        reject("ASSET_NOT_READY", "图片尚未上传完成");
    } else if (existing && canonical(existing) !== canonical(value))
      skipped.push(value.id);
  }

  const ordered = repairOrder(
    reconcileElementVersions(scene.elements, incoming),
  );
  const changed = ordered.filter(
    (element) => canonical(elements.get(element.id)) !== canonical(element),
  );

  return { elements: ordered, changed, skipped };
}
