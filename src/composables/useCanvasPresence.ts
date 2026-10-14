import { onBeforeUnmount, watch } from "vue";
import { api } from "~/lib/api";
import { getTabScope } from "~/lib/persistence";

/** Track an open editor separately from the account's durable background saves. */
export function useCanvasPresence(
  selection: () => { id: string; owner: string; mode?: string } | undefined,
  upgrade: (id: string) => Promise<void>,
  reportError: (message: string) => void,
) {
  const client = getTabScope();
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: ReturnType<typeof selection>;
  let pending = false;
  let departures = Promise.resolve();

  async function leave(value: NonNullable<typeof current>) {
    try {
      await api(`/api/canvases/${encodeURIComponent(value.id)}/presence`, {
        method: "POST",
        keepalive: true,
        signal: AbortSignal.timeout(3_000),
        headers: { "X-Resource-Owner": value.owner },
        body: JSON.stringify({ clientId: await client, leave: true }),
      });
    } catch (error) {
      // The lease expires when a keepalive request cannot finish.
      console.debug("画布离开通知未送达，将等待会话到期", error);
    }
  }

  async function touch() {
    clearTimeout(timer);
    if (!current || current.mode === "collaborative" || pending) return;
    const value = current;
    const ownGeneration = generation;

    pending = true;
    try {
      // Serialize previous leave acknowledgments before rejoining the same
      // canvas, so a delayed A → B departure cannot delete a fresh B → A open.
      await departures;
      if (ownGeneration !== generation) return;
      const result = await api<{ syncMode: string }>(
        `/api/canvases/${encodeURIComponent(value.id)}/presence`,
        {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
          headers: { "X-Resource-Owner": value.owner },
          body: JSON.stringify({ clientId: await client }),
        },
      );

      if (ownGeneration !== generation) {
        await leave(value);

        return;
      }

      if (result.syncMode !== "legacy") await upgrade(value.id);
    } catch (error) {
      if (ownGeneration === generation)
        reportError(
          error instanceof Error ? error.message : "画布会话检查失败",
        );
    } finally {
      pending = false;
      if (current && current.mode !== "collaborative")
        timer = setTimeout(
          () => void touch(),
          ownGeneration === generation ? 30_000 : 0,
        );
    }
  }

  const stop = watch(
    () => {
      const value = selection();

      return value ? `${value.owner}:${value.id}:${value.mode}` : "";
    },
    () => {
      generation++;
      clearTimeout(timer);
      const previous = current;

      current = selection();
      if (
        previous &&
        (previous.id !== current?.id || previous.owner !== current?.owner)
      )
        departures = departures.then(() => leave(previous));
      void touch();
    },
    { immediate: true },
  );
  const visible = () => {
    if (
      document.visibilityState !== "visible" ||
      !current ||
      current.mode === "collaborative"
    )
      return;
    const value = current;

    // Returning after suspension/expiry validates the canvas behind its normal
    // read-only guard before allowing another edit or renewing its open lease.
    void upgrade(value.id)
      .then(() => touch())
      .catch((error: unknown) => {
        reportError(
          error instanceof Error ? error.message : "画布版本检查失败",
        );
      });
  };
  const close = () => {
    if (current) void leave(current);
  };

  window.addEventListener("pagehide", close);
  window.addEventListener("pageshow", visible);
  window.addEventListener("online", visible);
  document.addEventListener("visibilitychange", visible);
  onBeforeUnmount(() => {
    generation++;
    stop();
    clearTimeout(timer);
    close();
    current = undefined;
    window.removeEventListener("pagehide", close);
    window.removeEventListener("pageshow", visible);
    window.removeEventListener("online", visible);
    document.removeEventListener("visibilitychange", visible);
  });
}
