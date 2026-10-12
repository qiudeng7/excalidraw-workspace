export function sanitizePresence(value: Record<string, unknown>) {
  const pointer = value.pointer as { x?: unknown; y?: unknown } | undefined;
  const selected = value.selectedElementIds;

  return {
    pointer:
      pointer &&
      typeof pointer.x === "number" &&
      Number.isFinite(pointer.x) &&
      typeof pointer.y === "number" &&
      Number.isFinite(pointer.y)
        ? { x: pointer.x, y: pointer.y, tool: "pointer" }
        : null,
    selectedElementIds:
      selected && typeof selected === "object"
        ? Object.fromEntries(
            Object.keys(selected)
              .slice(0, 100)
              .filter((id) => id.length <= 200)
              .map((id) => [id, true]),
          )
        : {},
  };
}
