import {
  isRichTextV1,
  richTextPlainText,
} from "@excalidraw/excalidraw/rich-text";
import { fail, isObject } from "#server/utils/http";

export function libraryElements(items: unknown): unknown[] {
  if (!Array.isArray(items)) return [];

  return items.flatMap((item) =>
    isObject(item) && Array.isArray(item.elements) ? item.elements : [],
  );
}

/** Guard the current snapshot as well: legacy restore may already have stripped incoming fields. */
export function assertRichTextWrite(
  incoming: unknown[],
  current: unknown[],
  formatVersion: unknown,
) {
  const containsRichText = (element: unknown) =>
    isObject(element) && element.richText !== undefined;

  if (
    (incoming.some(containsRichText) || current.some(containsRichText)) &&
    formatVersion !== 1
  )
    fail(
      409,
      "TEXT_FORMAT_REQUIRED",
      "内容包含富文本，请刷新页面后继续编辑。本地草稿已保留。",
    );
  for (const element of [...current, ...incoming]) {
    if (!containsRichText(element)) continue;
    const value = element as Record<string, unknown>;

    if (
      value.type !== "text" ||
      !isRichTextV1(value.richText) ||
      value.originalText !== richTextPlainText(value.richText)
    )
      fail(
        400,
        "INVALID_RICH_TEXT",
        "富文本格式或文本投影无效，请更新页面后重试",
      );
  }
}
