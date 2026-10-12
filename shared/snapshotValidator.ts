/** Private application cache validators; authorization always precedes comparison. */
export function snapshotValidator(
  type: "canvas" | "library",
  id: string,
  revision: number,
  updatedAt = "",
) {
  return `"${encodeURIComponent(`${type}:${id}:${revision}:${updatedAt}`)}"`;
}

/** Canvas responses also contain mutable catalog metadata, even when scene revision is unchanged. */
export function canvasValidator(canvas: import("./contracts").CanvasMeta) {
  if (canvas.syncMode === "collaborative" && canvas.roomEpoch)
    return `"collaboration:${canvas.roomEpoch}:${canvas.revision}:${encodeURIComponent(canvas.name)}"`;

  return snapshotValidator(
    "canvas",
    canvas.id,
    canvas.revision,
    JSON.stringify([
      canvas.updatedAt,
      canvas.name,
      canvas.position,
      canvas.workspaceId,
      canvas.createdAt,
    ]),
  );
}
