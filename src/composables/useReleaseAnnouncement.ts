import { onBeforeUnmount, ref, watch } from "vue";
import { currentRelease } from "~/data/releases";
import { announcementPrefix, ReleaseProgress } from "~/lib/releaseProgress";

export function useReleaseAnnouncement(
  accountId: () => string | undefined,
  ready: () => boolean,
) {
  const progress = new ReleaseProgress();
  const open = ref(false);
  const owner = ref<string>();
  const notice = ref("");
  const visible = ref(document.visibilityState === "visible");
  const suppressed = new Set<string>();
  let generation = 0;
  let pending = false;
  let displayed = false;
  let controller: AbortController | undefined;
  let releaseLock: (() => void) | undefined;

  function finish() {
    const release = releaseLock;

    releaseLock = undefined;
    release?.();
  }

  function cancelAttempt() {
    generation++;
    controller?.abort();
    finish();
    pending = false;
  }

  async function consider() {
    const id = accountId();

    if (
      !id ||
      !ready() ||
      !visible.value ||
      open.value ||
      pending ||
      suppressed.has(id) ||
      progress.highest(id) >= currentRelease.sequence
    )
      return;
    const token = ++generation;
    const abort = new AbortController();

    controller = abort;
    pending = true;
    const present = async () => {
      if (
        token !== generation ||
        accountId() !== id ||
        !ready() ||
        !visible.value ||
        progress.highest(id) >= currentRelease.sequence
      )
        return;
      owner.value = id;
      displayed = false;
      open.value = true;
      // Release only after visible content is recorded (or the attempt is cancelled).
      await new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    };

    try {
      if (navigator.locks)
        await navigator.locks.request(
          `${announcementPrefix(id)}display`,
          { signal: abort.signal },
          present,
        );
      else await present();
    } catch (error) {
      if (!abort.signal.aborted) {
        console.warn("无法协调公告标签页，使用本页展示", error);
        await present();
      }
    } finally {
      if (token === generation) pending = false;
    }
  }

  function shown(id: string) {
    if (accountId() !== id) return;
    notice.value = "";
    progress.shown(id, currentRelease);
    if (owner.value === id && open.value) {
      displayed = true;
      finish();
    }
  }

  function close() {
    if (owner.value) suppressed.add(owner.value);
    open.value = false;
    cancelAttempt();
  }

  function failed(id: string, error: unknown) {
    if (id !== accountId()) return;
    close();
    notice.value = "更新公告暂时无法打开，可重试或从设置中的更新日志查看。";
    console.warn("更新公告打开失败", error);
  }

  function retry() {
    const id = accountId();

    if (id) suppressed.delete(id);
    notice.value = "";
    void consider();
  }

  function onVisibility() {
    visible.value = document.visibilityState === "visible";
  }

  function onStorage(event: StorageEvent) {
    const id = accountId();

    if (!id || !event.key?.startsWith(announcementPrefix(id))) return;
    if (
      progress.highest(id) >= currentRelease.sequence &&
      open.value &&
      !displayed
    )
      close();
    else void consider();
  }

  watch(
    [accountId, ready, visible],
    ([id, canShow], previous) => {
      if (id !== previous?.[0]) {
        cancelAttempt();
        open.value = false;
        owner.value = undefined;
        notice.value = "";
      }

      if (!canShow && !open.value) cancelAttempt();
      if (canShow) void consider();
    },
    { immediate: true, flush: "post" },
  );
  window.addEventListener("storage", onStorage);
  document.addEventListener("visibilitychange", onVisibility);
  onBeforeUnmount(() => {
    cancelAttempt();
    window.removeEventListener("storage", onStorage);
    document.removeEventListener("visibilitychange", onVisibility);
  });

  return { open, owner, notice, shown, close, failed, retry };
}
