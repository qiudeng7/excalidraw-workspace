export interface DirectorySelectionPoint {
  x: number;
  y: number;
}

export interface DirectorySelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DirectorySelectionViewport {
  left: number;
  top: number;
  scrollLeft: number;
  scrollTop: number;
}

export interface DirectorySelectionRowRect {
  key: string;
  rect: DirectorySelectionRect;
}

export const toDirectoryContentPoint = (
  point: DirectorySelectionPoint,
  viewport: DirectorySelectionViewport,
): DirectorySelectionPoint => ({
  x: point.x - viewport.left + viewport.scrollLeft,
  y: point.y - viewport.top + viewport.scrollTop,
});

export const directorySelectionRect = (
  start: DirectorySelectionPoint,
  end: DirectorySelectionPoint,
): DirectorySelectionRect => ({
  left: Math.min(start.x, end.x),
  top: Math.min(start.y, end.y),
  right: Math.max(start.x, end.x),
  bottom: Math.max(start.y, end.y),
});

export const hitDirectorySelectionRows = (
  rect: DirectorySelectionRect,
  rows: readonly DirectorySelectionRowRect[],
): string[] => {
  if (rect.right <= rect.left || rect.bottom <= rect.top) return [];

  return [
    ...new Set(
      rows
        .filter(
          ({ rect: row }) =>
            row.right > rect.left &&
            row.left < rect.right &&
            row.bottom > rect.top &&
            row.top < rect.bottom &&
            row.right > row.left &&
            row.bottom > row.top,
        )
        .map(({ key }) => key),
    ),
  ];
};

export const directoryAutoScrollDelta = (
  pointerY: number,
  viewportTop: number,
  viewportBottom: number,
): number =>
  pointerY < viewportTop + 42 ? -9 : pointerY > viewportBottom - 42 ? 9 : 0;
