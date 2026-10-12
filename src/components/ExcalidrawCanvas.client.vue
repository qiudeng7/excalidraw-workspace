<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import { createElement, Fragment } from "react";
import { onBeforeRouteLeave, useRouter } from "vue-router";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  Excalidraw,
  FONT_FAMILY,
  MainMenu,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type {
  AppState,
  ExcalidrawProps,
  ExcalidrawInitialDataState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  CanvasDocument,
  CanvasScene,
  UserSettings,
} from "../../shared/contracts";
import type { SaveResource } from "../lib/persistence";
import type { CanvasResource, CanvasResources } from "../lib/canvasResources";
import type { EditorHandle } from "../lib/editor";
import type { UserSettingsStatus } from "../lib/userSettings";
import { confirmDialog, isAppDialogOpen } from "../lib/dialogs";

const props = defineProps<{
  document: CanvasDocument;
  entry: CanvasResource;
  resources: CanvasResources;
  userId: string;
  userSettings: UserSettings;
  settingsStatus: UserSettingsStatus;
  settingsOpen: boolean;
}>();

defineEmits<{
  "retry-load": [];
}>();
const message = ref(props.entry.message);
const { theme, preference, setPreference } = useTheme();
const loading = ref(true);
const manualSaveMessage = ref("");
const manualSaveFailed = ref(false);
let manualSaving = false;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

async function saveManually() {
  clearTimeout(feedbackTimer);
  if (manualSaving) {
    manualSaveMessage.value = "正在保存到云端…";

    return;
  }

  manualSaveFailed.value = false;
  if (!active || container.value?.closest("[inert]")) {
    manualSaveMessage.value = "画布正在加载，请稍候再保存";
    feedbackTimer = setTimeout(() => {
      manualSaveMessage.value = "";
    }, 3000);

    return;
  }

  manualSaving = true;
  manualSaveMessage.value = "正在保存到云端…";
  try {
    if (syncReadOnly()) throw new Error("画布版本校验完成后才能保存。");
    await Promise.all([sceneResource.saveNow(), libraryResource().flush()]);
    if (active) manualSaveMessage.value = "已保存到云端";
  } catch (error) {
    if (active) {
      manualSaveFailed.value = true;
      manualSaveMessage.value = `保存失败，请重试：${error instanceof Error ? error.message : "未知错误"}`;
    }
  } finally {
    manualSaving = false;
    if (active)
      feedbackTimer = setTimeout(() => {
        manualSaveMessage.value = "";
      }, 4000);
  }
}

function saveShortcut(event: KeyboardEvent) {
  if (props.settingsOpen) {
    if (
      (event.ctrlKey || event.metaKey) &&
      ["s", "f", "/", "p"].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    return;
  }

  if (
    !(event.ctrlKey || event.metaKey) ||
    event.altKey ||
    event.shiftKey ||
    event.key.toLowerCase() !== "s"
  )
    return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!event.repeat && !isAppDialogOpen()) void saveManually();
}

const hasConflict = ref(false);
const otherDrafts = ref<
  { key: string; label: string; filename: string; data: unknown }[]
>([]);
const selectedOtherDraft = ref("");

function downloadOtherDraft() {
  const draft = otherDrafts.value.find(
    (item) => item.key === selectedOtherDraft.value,
  );

  if (!draft) return;
  downloadJson(draft.filename, draft.data);
}

function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data)], { type: "application/json" }),
  );
  const link = document.createElement("a");

  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let active = false;
let sceneFingerprint = "";
let libraryFingerprint = "";

function stateChanged(error?: string) {
  hasConflict.value = sceneResource.conflict || libraryResource().conflict;
  if (error) message.value = error;
  else if (!sceneResource.dirty && !libraryResource().dirty) message.value = "";
}

const sceneResource: SaveResource<CanvasScene> = props.entry.resource;
const emptyLibrary: SaveResource<unknown[]> = {
  value: [],
  revision: 0,
  dirty: false,
  conflict: false,
  isSaving: false,
  hasUnconfirmedSave: false,
  restore: async () => {},
  checkpoint: async () => {},
  settle: async () => {},
  pauseAutosave: () => {},
  resumeAutosave: () => {},
  update: () => {},
  schedule: () => {},
  flush: async () => {},
  saveNow: async () => {},
  findOtherDrafts: async () => [],
  discardDraft: async () => {},
  dispose: () => {},
};
const libraryResource = () => props.resources.library ?? emptyLibrary;
// Manager status can change before Vue delivers the next document prop. Keep
// React and input guards locked until the wrapper explicitly commits the handoff.
let renderedReadOnly = props.entry.status !== "ready";
const syncReadOnly = () => props.entry.status !== "ready" || renderedReadOnly;
let userViewMode =
  props.entry.editorContext?.viewModeEnabled ??
  !!props.document.scene.appState.viewModeEnabled;
let restoringContext = false;
let injectedLibrary = false;

let injectingLibrary: Promise<void> | undefined;

async function ensureLibrary() {
  if (props.userSettings.features.disableDefaultSidebar) return;
  try {
    await props.resources.ensureLibrary();
  } catch (error) {
    if (active)
      message.value = `素材库加载失败：${error instanceof Error ? error.message : "未知错误"}`;

    return;
  }

  if (
    !active ||
    !editorApi ||
    syncReadOnly() ||
    props.resources.libraryStatus !== "ready" ||
    injectedLibrary
  )
    return;
  if (injectingLibrary) return injectingLibrary;
  const editor = editorApi;

  root?.render(createElement(CanvasEditor));
  // Inject after React receives libraryReady. All hydration callbacks are ignored until it settles.
  injectingLibrary = (async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    if (
      !active ||
      editorApi !== editor ||
      syncReadOnly() ||
      props.userSettings.features.disableDefaultSidebar
    )
      return;
    const items = await editor.updateLibrary({
      libraryItems: libraryResource().value as never,
      merge: false,
    });

    if (!active || editorApi !== editor) return;
    libraryFingerprint = JSON.stringify(items);
    injectedLibrary = true;
  })()
    .catch((error) => {
      message.value = `素材库显示失败：${error instanceof Error ? error.message : "未知错误"}`;
    })
    .finally(() => {
      injectingLibrary = undefined;
    });

  return injectingLibrary;
}

async function flush() {
  await Promise.all([sceneResource.flush(), libraryResource().flush()]);
}

async function retry() {
  try {
    await flush();
  } catch (error) {
    // The resource keeps its save state and reports the failure to the user.
    if (active) console.warn("重新保存失败，保留当前错误与草稿", error);
  }
}

async function loadCloudVersion() {
  if (
    !(await confirmDialog({
      title: "丢弃冲突草稿",
      message:
        "请先下载本地备份。继续将丢弃发生冲突的本地草稿，重新加载云端内容。确定继续？",
      confirmLabel: "丢弃并加载云端",
      danger: true,
    }))
  )
    return;
  try {
    // Keep a non-conflicting resource's pending draft intact across the reload.
    if (sceneResource.conflict) await sceneResource.discardDraft();
    if (libraryResource().conflict) await libraryResource().discardDraft();
    window.location.reload();
  } catch (error) {
    message.value = `无法清理本地草稿，请保留备份后重试：${error instanceof Error ? error.message : "未知错误"}`;
  }
}

function downloadBackup() {
  downloadJson(`${props.document.name}.excalidraw`, {
    type: "excalidraw",
    version: 2,
    source: location.origin,
    ...sceneResource.value,
  });
  if (props.resources.library)
    downloadJson("素材库.excalidrawlib", {
      type: "excalidrawlib",
      version: 2,
      source: location.origin,
      libraryItems: props.resources.library.value,
    });
}

const snapshot: NonNullable<ExcalidrawProps["onChange"]> = (
  elements,
  appState,
  files,
) => {
  if (!active) return;
  if (
    appState.openSidebar?.name === "default" &&
    (!appState.openSidebar.tab || appState.openSidebar.tab === "library") &&
    props.resources.libraryStatus === "unloaded"
  )
    void ensureLibrary();
  if (syncReadOnly()) return;
  if (!restoringContext) {
    userViewMode = appState.viewModeEnabled;
    props.entry.editorContext = {
      viewModeEnabled: userViewMode,
      activeTool: { ...appState.activeTool },
    };
  }

  // Upstream's export filter removes transient selections/collaborators and keeps referenced images.
  const serialized = serializeAsJSON(elements, appState, files, "local");
  const fingerprint = serialized;

  if (fingerprint === sceneFingerprint) return;
  sceneFingerprint = fingerprint;
  const data = JSON.parse(serialized) as CanvasScene;

  sceneResource.update({
    elements: data.elements,
    appState: data.appState,
    files: data.files,
  });
};

function beforeUnload(event: BeforeUnloadEvent) {
  if (
    props.resources.hasDirty() ||
    ["pending", "saving", "error", "conflict"].includes(props.settingsStatus)
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
}

onBeforeRouteLeave(async () => {
  try {
    await flush();

    return true;
  } catch (error) {
    if (active)
      message.value = `保存未完成，已暂停页面跳转：${error instanceof Error ? error.message : "未知错误"}`;

    return false;
  }
});

function capture() {
  if (!editorApi || syncReadOnly()) return;
  snapshot(
    editorApi.getSceneElements(),
    editorApi.getAppState(),
    editorApi.getFiles(),
  );
}

defineExpose<EditorHandle>({ capture, flush, saveManually });

const container = useTemplateRef<HTMLDivElement>("container");
const router = useRouter();
let root: Root | undefined;
let editorApi: ExcalidrawImperativeAPI | undefined;

function toolDefaults(features = props.userSettings.features) {
  return {
    currentItemFontFamily: features.nunitoFont
      ? FONT_FAMILY.Nunito
      : FONT_FAMILY.Excalifont,
    currentItemRoughness: features.formalLines ? 0 : 1,
    currentItemStrokeStyle: "solid" as const,
    currentItemFillStyle: "solid" as const,
  };
}

// Apply only flags that actually changed: a debug toggle must preserve the user's selected font/style.
watch(
  () => [
    props.userSettings.features.nunitoFont,
    props.userSettings.features.formalLines,
    props.userSettings.features.solidFill,
  ],
  (next, previous) => {
    if (!editorApi || next.every((value, index) => value === previous[index]))
      return;
    const defaults = toolDefaults(),
      current = editorApi.getAppState();

    editorApi.updateScene({
      appState: {
        currentItemFontFamily:
          next[0] !== previous[0]
            ? defaults.currentItemFontFamily
            : current.currentItemFontFamily,
        currentItemRoughness:
          next[1] !== previous[1]
            ? defaults.currentItemRoughness
            : current.currentItemRoughness,
        currentItemStrokeStyle:
          next[1] !== previous[1]
            ? defaults.currentItemStrokeStyle
            : current.currentItemStrokeStyle,
        currentItemFillStyle:
          next[2] !== previous[2]
            ? defaults.currentItemFillStyle
            : current.currentItemFillStyle,
      },
    });
  },
);
watch(
  () => [theme.value, preference.value, props.settingsOpen, props.document],
  () => {
    stateChanged(props.entry.message || props.resources.libraryMessage);
    const nextReadOnly = props.entry.status !== "ready";
    const unlocked = renderedReadOnly && !nextReadOnly;
    const context = props.entry.editorContext;
    const restoreViewMode = userViewMode;

    if (unlocked) {
      restoringContext = true;
      // Only the already-rendered readonly viewport becomes the new baseline.
      // Subsequent real content changes continue through snapshot() during restoration.
      if (editorApi)
        sceneFingerprint = serializeAsJSON(
          editorApi.getSceneElements(),
          editorApi.getAppState(),
          editorApi.getFiles(),
          "local",
        );
    }

    renderedReadOnly = nextReadOnly;
    if (unlocked) {
      // Commit the controlled readonly prop's removal before restoring the user's
      // uncontrolled mode. A rAF can run before React commits and lose this restore.
      flushSync(() => root?.render(createElement(CanvasEditor)));
      if (active && !syncReadOnly() && editorApi) {
        const editor = editorApi;

        flushSync(() =>
          editor.updateScene({
            appState: {
              viewModeEnabled: restoreViewMode,
              activeTool: context
                ? (context.activeTool as AppState["activeTool"])
                : editor.getAppState().activeTool,
            },
          }),
        );
      }

      restoringContext = false;
    } else root?.render(createElement(CanvasEditor));
    if (
      props.resources.libraryStatus === "ready" &&
      !injectedLibrary &&
      !syncReadOnly()
    )
      void ensureLibrary();
  },
);
watch(
  () => props.userSettings,
  () => root?.render(createElement(CanvasEditor)),
  { deep: true },
);

function CanvasEditor() {
  return createElement(Excalidraw, {
    // Native modal inertness isolates pointer input; keep editor state intact.
    // Keyboard input stays scoped to the editor, not the teleported settings.
    handleKeyboardGlobally: false,
    syncReadOnly: syncReadOnly(),
    viewModeEnabled: syncReadOnly() ? true : undefined,
    libraryReady:
      props.resources.libraryStatus === "ready" &&
      !props.userSettings.features.disableDefaultSidebar,
    libraryPreview: props.resources.libraryPreview as never,
    onPaste: () => !syncReadOnly(),
    canvasSampling: props.userSettings.debug.sampling,
    canvasRenderingOptions: props.userSettings.debug.renderingOptions,
    arrowBindingOptimization: props.userSettings.features.edgeBinding,
    shortArrowheads: props.userSettings.features.shortArrowheads,
    UIOptions: {
      defaultSidebar: !props.userSettings.features.disableDefaultSidebar,
    },
    langCode: "zh-CN",
    theme: theme.value,
    onThemeChange: setPreference,
    children: createElement(
      MainMenu,
      null,
      createElement(MainMenu.DefaultItems.LoadScene),
      createElement(MainMenu.DefaultItems.SaveToActiveFile),
      createElement(MainMenu.DefaultItems.Export),
      createElement(MainMenu.DefaultItems.SaveAsImage),
      createElement(MainMenu.DefaultItems.SearchMenu),
      createElement(MainMenu.DefaultItems.CommandPalette),
      createElement(MainMenu.DefaultItems.Help),
      createElement(MainMenu.DefaultItems.ClearCanvas),
      createElement(MainMenu.Separator),
      createElement(MainMenu.DefaultItems.ToggleTheme, {
        allowSystemTheme: true,
        theme: preference.value,
      }),
      createElement(MainMenu.DefaultItems.ChangeCanvasBackground),
      createElement(MainMenu.Group, {
        title: "跳转",
        className: "canvas-menu-group",
        children: createElement(
          Fragment,
          null,
          createElement(MainMenu.Item, {
            children: "首页",
            onSelect: () => {
              void router.push("/home");
            },
          }),
          createElement(MainMenu.Item, {
            children: "关于",
            onSelect: () => {
              void router.push("/about");
            },
          }),
        ),
      }),
    ),
    initialData: {
      ...sceneResource.value,
      appState: {
        ...sceneResource.value.appState,
        ...toolDefaults(),
        viewModeEnabled: userViewMode,
        ...(props.entry.editorContext
          ? { activeTool: props.entry.editorContext.activeTool }
          : {}),
      },
    } as ExcalidrawInitialDataState,
    onInitialize: (editor) => {
      editorApi = editor;
      editor.updateScene({ appState: toolDefaults() });
      sceneFingerprint = serializeAsJSON(
        editor.getSceneElements(),
        editor.getAppState(),
        editor.getFiles(),
        "local",
      );
      libraryFingerprint = JSON.stringify(libraryResource().value);
      injectedLibrary = false;
      active = true;
      if (props.resources.libraryStatus === "ready") void ensureLibrary();
      if (sceneResource.dirty) sceneResource.schedule();
      if (libraryResource().dirty) libraryResource().schedule();
      stateChanged(
        sceneResource.conflict || libraryResource().conflict
          ? message.value
          : undefined,
      );
    },
    onChange: snapshot,
    onLibraryChange: (items) => {
      if (
        !active ||
        !injectedLibrary ||
        syncReadOnly() ||
        props.resources.libraryStatus !== "ready"
      )
        return;
      const fingerprint = JSON.stringify(items);

      if (fingerprint === libraryFingerprint) return;
      libraryFingerprint = fingerprint;
      libraryResource().update([...items]);
    },
  });
}

onMounted(async () => {
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("keydown", saveShortcut, true);

  try {
    const [scenes, libraries] = await Promise.all([
      sceneResource.findOtherDrafts(),
      libraryResource().findOtherDrafts(),
    ]);

    otherDrafts.value = [
      ...scenes.map((draft, index) => ({
        key: draft.key,
        label: `画布草稿 ${index + 1} · ${draft.updatedAt ? new Date(draft.updatedAt).toLocaleString() : "较早版本"}`,
        filename: `${props.document.name}-草稿.excalidraw`,
        data: {
          type: "excalidraw",
          version: 2,
          source: location.origin,
          ...draft.value,
        },
      })),
      ...libraries.map((draft, index) => ({
        key: draft.key,
        label: `素材库草稿 ${index + 1} · ${draft.updatedAt ? new Date(draft.updatedAt).toLocaleString() : "较早版本"}`,
        filename: "素材库-草稿.excalidrawlib",
        data: {
          type: "excalidrawlib",
          version: 2,
          source: location.origin,
          libraryItems: draft.value,
        },
      })),
    ];
    selectedOtherDraft.value = otherDrafts.value[0]?.key ?? "";
  } catch (error) {
    console.warn("无法读取其他标签页的草稿", error);
    message.value = "其他标签页的草稿暂时无法读取，请保留原页面以免丢失内容。";
  }

  if (!container.value) return;
  loading.value = false;
  root = createRoot(container.value);
  root.render(createElement(CanvasEditor));
});

onBeforeUnmount(() => {
  active = false;
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("keydown", saveShortcut, true);
  clearTimeout(feedbackTimer);
  // Account-level resources keep pending saves alive across canvas switches.
  root?.unmount();
  root = undefined;
  editorApi = undefined;
});
</script>

<template>
  <div class="canvas-editor-shell">
    <div
      v-if="manualSaveMessage"
      class="manual-save-feedback"
      :class="{ failed: manualSaveFailed }"
      :role="manualSaveFailed ? 'alert' : 'status'"
    >
      {{ manualSaveMessage }}
    </div>
    <div
      v-if="entry.status !== 'ready'"
      class="save-notice"
      role="status"
      data-testid="canvas-sync-lock"
    >
      <span>{{
        entry.status === "checking"
          ? "正在确认最新版本，暂时只读，可平移和缩放。"
          : entry.status === "conflict"
            ? "版本冲突，已保留本地草稿。"
            : "版本校验失败，当前内容只读。"
      }}</span>
      <button
        v-if="entry.status === 'error'"
        type="button"
        @click="$emit('retry-load')"
      >
        重新校验
      </button>
      <button
        v-if="entry.status === 'conflict'"
        type="button"
        @click="downloadBackup"
      >
        下载本地备份
      </button>
      <button
        v-if="entry.status === 'conflict'"
        type="button"
        @click="loadCloudVersion"
      >
        丢弃草稿并加载云端
      </button>
    </div>
    <div
      v-if="
        resources.libraryStatus === 'loading' ||
        resources.libraryStatus === 'error'
      "
      class="save-notice"
      role="status"
    >
      <span>{{
        resources.libraryStatus === "loading"
          ? "正在加载素材库…"
          : resources.libraryMessage
      }}</span>
      <button
        v-if="resources.libraryStatus === 'error'"
        type="button"
        @click="ensureLibrary"
      >
        重试素材库
      </button>
    </div>
    <div v-if="loading" class="save-notice">正在加载画布与本地草稿…</div>
    <div v-if="message" class="save-notice" role="alert">
      <span>{{ message }}</span>
      <button type="button" @click="retry">重试保存</button>
      <button type="button" @click="downloadBackup">下载本地备份</button>
      <button v-if="hasConflict" type="button" @click="loadCloudVersion">
        加载云端版本
      </button>
    </div>
    <div v-if="otherDrafts.length" class="save-notice">
      <span
        >发现其他页面或之前会话的本地草稿，可下载后通过画布菜单或素材库导入恢复。</span
      >
      <select v-model="selectedOtherDraft" aria-label="其他本地草稿">
        <option
          v-for="draft in otherDrafts"
          :key="draft.key"
          :value="draft.key"
        >
          {{ draft.label }}
        </option>
      </select>
      <button type="button" @click="downloadOtherDraft">下载所选草稿</button>
    </div>
    <div
      ref="container"
      class="canvas-host"
      :class="
        userSettings.features.bottomToolbar ? 'toolbar-bottom' : 'toolbar-top'
      "
    />
  </div>
</template>

<style scoped>
.canvas-editor-shell {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.manual-save-feedback {
  position: absolute;
  z-index: 30;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 16px;
  border: 1px solid var(--app-success-border);
  border-radius: 10px;
  background: var(--app-success-bg);
  color: var(--app-success);
  font-size: 13px;
  box-shadow: 0 4px 16px #0001;
  pointer-events: none;
  max-width: calc(100% - 48px);
}
.manual-save-feedback.failed {
  background: var(--app-danger-bg);
  color: var(--app-danger);
  border-color: var(--app-danger-border);
}
.save-notice {
  padding: 8px 12px;
  background: var(--app-warning-bg);
  color: var(--app-warning);
  font-size: 13px;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.save-notice button {
  border: 1px solid var(--app-warning-border);
  background: var(--app-surface);
  color: var(--app-text);
  border-radius: 4px;
  padding: 4px 8px;
  cursor: pointer;
}
.save-notice select {
  border: 1px solid var(--app-warning-border);
  background: var(--app-surface);
  color: var(--app-text);
}

.canvas-host {
  flex: 1;
  min-height: 0;
  width: 100%;
  height: 100%;
  container-type: inline-size;
}

.canvas-host :deep(.canvas-menu-group > .dropdown-menu-group-title) {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1rem 0 0.5rem;
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--color-gray-60);
}

.canvas-host :deep(.canvas-menu-group > .dropdown-menu-group-title)::before,
.canvas-host :deep(.canvas-menu-group > .dropdown-menu-group-title)::after {
  content: "";
  height: 1px;
  flex: 1;
  background: var(--default-border-color);
}

/* 菜单较长，窄屏也沿用容器滚动，预留上下操作区。 */
.canvas-host :deep(.dropdown-menu .dropdown-menu-container) {
  max-height: calc(100dvh - 150px);
  overflow-y: auto;
}

/* Radix measures the space on the menu's actual opening side. Include the
   extra-tools menu's margin so its last item stays inside the viewport. */
.canvas-host
  :deep(.App-toolbar__extra-tools-dropdown .dropdown-menu-container) {
  max-height: min(
    calc(100dvh - 150px),
    calc(var(--radix-dropdown-menu-content-available-height) - 0.375rem)
  );
}

/* 工具栏以画布内部的 FixedSideContainer 为定位边界。 */
.canvas-host.toolbar-bottom :deep(.App-menu_top) {
  grid-template-columns: 1fr 1fr;
}

.canvas-host.toolbar-bottom :deep(.App-menu_top > .shapes-section) {
  position: absolute;
  inset-inline: 0;
  bottom: env(safe-area-inset-bottom, 0px);
  justify-self: stretch;
}

.canvas-host.toolbar-bottom :deep(.App-toolbar .HintViewer) {
  top: auto;
  bottom: 100%;
  margin-top: 0;
  margin-bottom: 0.5rem;
}

/* 更多工具随工具栏向上展开，避免超出画布。 */
.canvas-host.toolbar-bottom :deep(.App-toolbar__extra-tools-dropdown) {
  top: auto;
  bottom: calc(100% + 0.375rem);
  margin-top: 0;
}

/* 移动工具栏原生置底；置顶时在顶部操作行下方排列，属性面板向下展开。 */
.canvas-host.toolbar-top :deep(.excalidraw--mobile .App-bottom-bar) {
  top: calc(3.5rem + env(safe-area-inset-top, 0px));
  bottom: auto;
  flex-direction: column-reverse;
  max-height: calc(100% - 5rem);
}

@container (max-width: 960px) {
  .canvas-host.toolbar-bottom :deep(.App-menu_top > .shapes-section) {
    bottom: calc(3.5rem + env(safe-area-inset-bottom, 0px));
  }

  .canvas-host :deep(.shapes-section > div) {
    max-width: 100%;
  }

  .canvas-host :deep(.App-toolbar > .Stack_horizontal) {
    flex-wrap: wrap;
    justify-content: center;
  }
}
</style>
