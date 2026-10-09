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
): NavigationController {
  const navigation = ref<Navigation>();
  const navigationNotice = ref("");

  async function readNavigation() {
    navigation.value = await api.readNavigation();

    return navigation.value;
  }

  async function refreshNavigationQuietly() {
    try {
      await readNavigation();
    } catch (error) {
      console.warn("最近打开位置读取失败，使用画布列表回退", error);
      navigation.value = undefined;
      navigationNotice.value = "最近打开位置暂时无法读取，画布仍可正常使用。";
    }
  }

  async function recordOpened(id: string) {
    navigationNotice.value = "";
    try {
      const current = navigation.value ?? (await readNavigation());

      navigation.value = await api.recordOpened(id, current.revision);
    } catch (cause) {
      navigationNotice.value =
        cause instanceof ApiError && cause.code === "NAVIGATION_CONFLICT"
          ? "当前画布已打开，最近位置已在其他页面更新。"
          : "画布已打开，最近位置未保存。下次切换时会再次尝试。";
      // Adopt the winning version without retrying the write or moving the current editor.
      try {
        await readNavigation();
      } catch (error) {
        console.warn("无法读取其他页面提交的最近位置", error);
        navigation.value = undefined;
      }
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
      navigation.value = undefined;
      clearNotice();
    },
  };
}
