// A document can remount the same canvas through owner/share/editor scopes.
// Serialize their lease requests so an old touch cannot overtake a new scope.
const pending = new Map<string, Promise<unknown>>();

export function enqueueCanvasPresence<T>(
  canvasId: string,
  task: () => Promise<T>,
): Promise<T> {
  const result = (pending.get(canvasId) ?? Promise.resolve())
    .catch(() => {})
    .then(task);

  pending.set(canvasId, result);
  void result
    .finally(() => {
      if (pending.get(canvasId) === result) pending.delete(canvasId);
    })
    .catch(() => {});

  return result;
}
