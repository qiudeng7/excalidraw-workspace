/** Compact, visible connection state for narrow toolbars; full text stays in the label. */
export function compactRealtimeStatus(text: string) {
  if (text.includes("待休眠")) return "待休眠";
  if (text.includes("未启用")) return "未启用";
  if (text.includes("休眠")) return "已休眠";
  if (text.includes("不可用")) return "不可用";
  if (text.includes("待确认")) return "待确认";
  const count = text.match(/^(\d+) 个会话/)?.[1];
  const state = text.includes("中断")
    ? "HTTP同步"
    : text.includes("已连接")
      ? "已连接"
      : "连接中";

  return count ? `${count}会话·${state}` : "启用中";
}
