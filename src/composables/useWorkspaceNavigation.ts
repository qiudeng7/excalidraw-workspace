import { shallowReadonly, ref, type Ref } from "vue";
import type { Navigation } from "../../shared/contracts";
import { ApiError } from "../lib/api";
import type { WorkspaceApi } from "../lib/workspaceApi";

export interface NavigationController {
  navigation: Readonly<Ref<Navigation | undefined>>;
  navigationNotice: Readonly<Ref<string>>;
  refreshNavigationQuietly(): Promise<void>;
  recordOpened(canvasId: string): Promise<void>;
  clearNotice(): void;
  reset(): void;
}

export function useWorkspaceNavigation(
  api: Pick<WorkspaceApi, "readNavigation" | "recordOpened">,
  ownerId: () => string | undefined = () => undefined,
): NavigationController {
  const navigation = ref<Navigation>();
  const navigationNotice = ref("");

  let generation = 0;

  async function readNavigation() {
    const captured = generation;
    const value = await api.readNavigation(ownerId());

    if (captured === generation) navigation.value = value;

    return value;
  }

  async function refreshNavigationQuietly() {
    const captured = generation;

    try {
      await readNavigation();
    } catch (error) {
      if (captured !== generation) return;
      console.warn("最近打开位置读取失败，使用画布列表回退", error);
      navigation.value = undefined;
      navigationNotice.value = "最近打开位置暂时无法读取，画布仍可正常使用。";
    }
  }

  async function saveOpened(
    id: string,
    captured: number,
    owner: string | undefined,
  ) {
    navigationNotice.value = "";
    try {
      const current = navigation.value ?? (await readNavigation());

      if (captured !== generation) return;
      const result = await api.recordOpened(id, current.revision, owner);

      if (captured === generation) navigation.value = result;
    } catch (cause) {
      if (captured !== generation) return;
      navigationNotice.value =
        cause instanceof ApiError && cause.code === "NAVIGATION_CONFLICT"
          ? "当前画布已打开，最近位置已在其他页面更新。"
          : "画布已打开，最近位置未保存。下次切换时会再次尝试。";
      // Adopt the winning version without retrying the write or moving the current editor.
      try {
        await readNavigation();
      } catch (error) {
        console.warn("无法读取其他页面提交的最近位置", error);
        if (captured === generation) navigation.value = undefined;
      }
    }
  }

  let pending: string | undefined;
  let recording: Promise<void> | undefined;

  async function recordOpened(id: string) {
    pending = id;
    if (recording) return recording;
    const captured = generation;
    const owner = ownerId();

    const task = (async () => {
      while (pending && captured === generation) {
        const latest = pending;

        pending = undefined;
        await saveOpened(latest, captured, owner);
      }
    })();

    recording = task;
    try {
      await task;
    } finally {
      if (recording === task) recording = undefined;
    }
  }

  const clearNotice = () => {
    navigationNotice.value = "";
  };

  return {
    navigation: shallowReadonly(navigation),
    navigationNotice: shallowReadonly(navigationNotice),
    refreshNavigationQuietly,
    recordOpened,
    clearNotice,
    reset() {
      generation++;
      pending = undefined;
      recording = undefined;
      navigation.value = undefined;
      clearNotice();
    },
  };
}
