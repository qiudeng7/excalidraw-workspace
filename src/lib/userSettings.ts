import { reactive } from "vue";
import { api, ApiError } from "./api";
import {
  createDefaultUserSettings,
  type UserSettings,
  type UserSettingsDocument,
} from "../../shared/contracts";
export type UserSettingsStatus =
  | "loading"
  | "unavailable"
  | "synced"
  | "pending"
  | "saving"
  | "error"
  | "conflict";
export interface UserSettingsState {
  settings: UserSettings;
  revision: number;
  configured: boolean;
  ready: boolean;
  status: UserSettingsStatus;
  error: string;
  cloudConflict: UserSettingsDocument | null;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** One resource belongs to one account/session. Dispose it before changing the owner. */
export function createUserSettingsResource(
  userId: string,
  isCurrent: () => boolean = () => true,
) {
  const state = reactive<UserSettingsState>({
    settings: createDefaultUserSettings(),
    revision: 0,
    configured: false,
    ready: false,
    status: "loading",
    error: "",
    cloudConflict: null,
  });
  let alive = true;
  let generation = 0;
  let localVersion = 0;
  let dirty = false;
  let needsConflict = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<boolean> | undefined;
  let loading: Promise<boolean> | undefined;
  const controllers = new Set<AbortController>();
  const current = (capturedGeneration = generation) =>
    alive && generation === capturedGeneration && isCurrent();
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  async function request<T>(
    method: "GET" | "PUT",
    payload?: unknown,
  ): Promise<T> {
    const capturedGeneration = generation;
    // Check immediately before dispatch: an old debounce must not use a new login cookie.
    if (!current(capturedGeneration))
      throw new DOMException("Settings owner changed", "AbortError");
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const result = await api<T>("/api/user-settings", {
        method,
        headers: { "X-Settings-Owner": userId },
        signal: controller.signal,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      if (!current(capturedGeneration))
        throw new DOMException("Settings owner changed", "AbortError");
      return result;
    } finally {
      controllers.delete(controller);
    }
  }
  function initialize(document: UserSettingsDocument) {
    state.settings = copy(document.settings);
    state.revision = document.revision;
    state.configured = document.configured;
    state.ready = true;
    state.status = "synced";
    state.error = "";
    state.cloudConflict = null;
    dirty = false;
    needsConflict = false;
    localVersion++;
  }
  async function readCloud(): Promise<boolean> {
    if (!current()) return false;
    clearTimer();
    state.ready = false;
    state.status = "loading";
    state.error = "";
    try {
      const document = await request<UserSettingsDocument>("GET");
      if (!current()) return false;
      initialize(document);
      return true;
    } catch (error) {
      if (!current()) return false;
      state.ready = false;
      state.status = "unavailable";
      state.error = error instanceof Error ? error.message : "未读取云端设置";
      return false;
    }
  }
  function load(): Promise<boolean> {
    // Never discard an unsaved preview through an unrelated reload action.
    if (!current() || dirty || saving) return Promise.resolve(false);
    loading ??= readCloud().finally(() => {
      loading = undefined;
    });
    return loading;
  }
  async function conflict(): Promise<boolean> {
    try {
      const document = await request<UserSettingsDocument>("GET");
      if (!current()) return false;
      state.cloudConflict = copy(document);
      state.status = "conflict";
      state.error =
        "设置已在其他页面更新，请选择使用云端设置或重新提交当前设置";
      needsConflict = false;
      return false;
    } catch (error) {
      if (!current()) return false;
      state.status = "error";
      state.error = error instanceof Error ? error.message : "无法读取云端设置";
      return false;
    }
  }
  async function drain(): Promise<boolean> {
    if (!current()) return false;
    if (needsConflict) return conflict();
    if (state.cloudConflict) return false;
    while (dirty && current()) {
      const value = copy(state.settings);
      const version = localVersion;
      const revision = state.revision;
      state.status = "saving";
      state.error = "";
      try {
        const document = await request<UserSettingsDocument>("PUT", {
          settings: value,
          revision,
        });
        if (!current()) return false;
        state.revision = document.revision;
        state.configured = document.configured;
        if (version === localVersion) dirty = false;
      } catch (error) {
        if (!current()) return false;
        if (
          error instanceof ApiError &&
          error.code === "USER_SETTINGS_CONFLICT"
        ) {
          needsConflict = true;
          return conflict();
        }
        state.status = "error";
        state.error = error instanceof Error ? error.message : "设置保存失败";
        return false;
      }
    }
    if (!current()) return false;
    state.status = "synced";
    state.error = "";
    return true;
  }
  function flush(): Promise<boolean> {
    clearTimer();
    if (!current()) return Promise.resolve(false);
    if (!dirty) return Promise.resolve(true);
    if (!state.ready) return Promise.resolve(false);
    saving ??= drain().finally(() => {
      saving = undefined;
    });
    return saving;
  }
  function update(settings: UserSettings): boolean {
    if (!current() || !state.ready) return false;
    state.settings = copy(settings);
    localVersion++;
    dirty = true;
    state.error = "";
    if (state.cloudConflict || needsConflict) {
      state.status = "conflict";
      return true;
    }
    state.status = saving ? "saving" : "pending";
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, 350);
    return true;
  }
  function useCloud(): boolean {
    if (!current() || !state.cloudConflict) return false;
    clearTimer();
    initialize(state.cloudConflict);
    return true;
  }
  function keepLocal(): Promise<boolean> {
    if (!current() || !state.cloudConflict) return Promise.resolve(false);
    state.revision = state.cloudConflict.revision;
    state.configured = state.cloudConflict.configured;
    state.cloudConflict = null;
    needsConflict = false;
    dirty = true;
    state.status = "pending";
    return flush();
  }
  function retry(): Promise<boolean> {
    return state.ready ? flush() : load();
  }
  function dispose() {
    if (!alive) return;
    alive = false;
    generation++;
    clearTimer();
    for (const controller of controllers) controller.abort();
    controllers.clear();
    dirty = false;
    needsConflict = false;
    state.ready = false;
    state.cloudConflict = null;
    state.settings = createDefaultUserSettings();
    state.error = "";
  }
  return {
    userId,
    state,
    load,
    update,
    flush,
    retry,
    useCloud,
    keepLocal,
    dispose,
  };
}
export type UserSettingsResource = ReturnType<
  typeof createUserSettingsResource
>;
