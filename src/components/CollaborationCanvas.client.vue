<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  useTemplateRef,
  watch,
} from "vue";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  Excalidraw,
  MainMenu,
  CaptureUpdateAction,
  FONT_FAMILY,
  serializeAsJSON,
  restoreElements,
  newElementWith,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import "~/assets/editor-layout.css";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { Operation } from "#shared/collaboration/types";
import {
  createDefaultUserSettings,
  type CanvasDocument,
  type CanvasScene,
  type UserSettings,
} from "#shared/contracts";
import { collaborationSession } from "~/lib/collaboration/session";
import type { CanvasResources } from "~/lib/canvasResources";
import type { EditorHandle } from "~/lib/editor";

const props = defineProps<{
  canvasId: string;
  userId?: string;
  token?: string;
  scope: string;
  initialDocument?: CanvasDocument;
  userSettings?: UserSettings;
  resources?: CanvasResources;
  settingsOpen?: boolean;
}>();
const emit = defineEmits<{
  ready: [];
  status: [message: string];
  title: [name: string];
  participants: [count: number, label: string];
  access: [role: string, mode: string];
}>();
const settings = computed(
  () => props.userSettings ?? createDefaultUserSettings(),
);
const host = useTemplateRef<HTMLDivElement>("host");
const { theme, preference, setPreference } = useTheme();
const session = collaborationSession({
  canvasId: props.canvasId,
  userId: props.userId,
  token: props.token,
  scope: props.scope,
});
const error = ref("");
const dirty = ref(false);
const readOnly = ref(true);
const initialized = ref(false);
let root: Root | undefined;
let editor: ExcalidrawImperativeAPI | undefined;
let alive = true;
let applying = false;
let hydrating = false;
let lastScene = "";
let libraryInjected = false;
let unsubscribe: (() => void) | undefined;
let lastPresence = 0;
let previousReadOnly = true;
let lastPeers = "";
let renderState = "";
let historyPreconditions: Operation["preconditions"];
let displayedElements: readonly ExcalidrawElement[] = [];

function applySession() {
  if (!alive) return;
  error.value = session.message;
  dirty.value = session.dirty;
  readOnly.value = !session.editable;
  emit("status", session.statusText);
  if (session.view) {
    emit("access", session.view.access.role, session.view.access.viewMode);
    emit("title", session.view.name);
  }

  const groups = new Map<string, { name: string; sessions: number }>();

  if (session.view?.access.viewMode === "live")
    groups.set(session.view.access.principalId, {
      name: session.view.access.name,
      sessions: 1,
    });
  for (const peer of session.peers.values()) {
    const id = String(peer.id);
    const group = groups.get(id) ?? {
      name: String(peer.username ?? "访客"),
      sessions: 0,
    };

    group.sessions++;
    groups.set(id, group);
  }

  emit(
    "participants",
    groups.size,
    [...groups.values()]
      .map(
        (group) =>
          `${group.name}${group.sessions > 1 ? `（${group.sessions} 个会话）` : ""}`,
      )
      .join("、"),
  );
  const nextRenderState = JSON.stringify([
    session.editable,
    session.view?.access.viewMode,
  ]);

  if (nextRenderState !== renderState) {
    renderState = nextRenderState;
    root?.render(createElement(CanvasEditor));
  }

  if (!editor || !session.view) return;
  if (previousReadOnly && session.editable) {
    flushSync(() => root?.render(createElement(CanvasEditor)));
    flushSync(() =>
      editor!.updateScene({
        appState: { viewModeEnabled: false },
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
  }

  previousReadOnly = !session.editable;
  const peers = JSON.stringify([...session.peers]);

  if (peers !== lastPeers) {
    lastPeers = peers;
    editor.updateScene({
      collaborators: new Map(
        [...session.peers].map(([id, peer]) => [id, peer]),
      ) as never,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }

  const value = session.value;
  const fingerprint = JSON.stringify(value);
  const state = editor.getAppState();

  // Let the active local interaction finish; onChange flushes the canonical scene afterward.
  if (
    state.editingTextElement ||
    state.newElement ||
    state.selectedElementsAreBeingDragged ||
    state.resizingElement
  )
    return;
  if (fingerprint === lastScene) return;
  applying = true;
  try {
    editor.addFiles(Object.values(value.files) as never);
    flushSync(() =>
      editor!.updateScene({
        elements: restoreElements(value.elements as never, null),
        appState: value.appState as never,
        collaborators: new Map(
          [...session.peers].map(([id, peer]) => [id, peer]),
        ) as never,
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
    displayedElements = editor.getSceneElementsIncludingDeleted();
    lastScene = fingerprint;
    if (!initialized.value) {
      editor.history.clear();
      initialized.value = true;
      emit("ready");
    }
  } finally {
    applying = false;
  }
}

async function ensureLibrary() {
  if (
    !props.resources ||
    settings.value.features.disableDefaultSidebar ||
    libraryInjected ||
    hydrating
  )
    return;
  hydrating = true;
  try {
    await props.resources.ensureLibrary();
    if (!alive || !editor || props.resources.libraryStatus !== "ready") return;
    root?.render(createElement(CanvasEditor));
    await editor.updateLibrary({
      libraryItems: props.resources.library?.value as never,
      merge: false,
    });
    libraryInjected = true;
  } catch (cause) {
    error.value = `素材库加载失败：${cause instanceof Error ? cause.message : "未知错误"}`;
  } finally {
    hydrating = false;
  }
}

const onChange: NonNullable<ExcalidrawProps["onChange"]> = (
  elements,
  appState,
  files,
) => {
  if (!alive || applying || !initialized.value) return;
  const previousElements = displayedElements;

  displayedElements = elements;
  if (
    appState.openSidebar?.name === "default" &&
    (!appState.openSidebar.tab || appState.openSidebar.tab === "library")
  )
    void ensureLibrary();
  if (session.editable) {
    const serialized = JSON.parse(
      serializeAsJSON(elements, appState, files, "local"),
    ) as CanvasScene;
    const present = new Set(elements.map((element) => element.id));

    // Imports/reset can omit old elements entirely. Only delete elements the
    // local editor actually displayed, never remote additions deferred during a drag.
    serialized.elements.push(
      ...previousElements
        .filter((element) => !element.isDeleted && !present.has(element.id))
        .map((element) => newElementWith(element, { isDeleted: true })),
    );

    if (session.update(serialized, historyPreconditions))
      historyPreconditions = undefined;
  }

  if (
    !appState.editingTextElement &&
    !appState.newElement &&
    !appState.selectedElementsAreBeingDragged &&
    !appState.resizingElement
  )
    queueMicrotask(applySession);
};

function capture() {
  if (editor)
    onChange(
      editor.getSceneElementsIncludingDeleted(),
      editor.getAppState(),
      editor.getFiles(),
    );
}

async function flush() {
  capture();
  await session.flush();
  await props.resources?.library?.flush();
}

async function checkpoint() {
  capture();
  await session.checkpoint();
  await props.resources?.library?.checkpoint();
}

async function saveManually() {
  try {
    await flush();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "同步失败";
  }
}

function download() {
  capture();
  const value =
    session.value.elements.length || session.view
      ? session.value
      : props.initialDocument?.scene;
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify({
          type: "excalidraw",
          version: 2,
          source: location.origin,
          ...value,
        }),
      ],
      { type: "application/json" },
    ),
  );
  const link = document.createElement("a");

  link.href = url;
  link.download = `${session.view?.name ?? props.initialDocument?.name ?? "画布"}-本地备份.excalidraw`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (session.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
}

function shortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    event.stopPropagation();
    if (!props.settingsOpen && !readOnly.value) void saveManually();
  }
}

defineExpose<EditorHandle & { checkpoint(): Promise<void> }>({
  capture,
  flush,
  checkpoint,
  saveManually,
  refresh: () => session.refresh(),
});

function CanvasEditor() {
  const flags = settings.value;

  return createElement(Excalidraw, {
    handleKeyboardGlobally: false,
    syncReadOnly: !session.editable,
    viewModeEnabled: session.editable ? undefined : true,
    isCollaborating: session.view?.access.viewMode === "live",
    libraryReady:
      !!props.resources &&
      props.resources.libraryStatus === "ready" &&
      !flags.features.disableDefaultSidebar,
    libraryPreview: props.resources?.libraryPreview as never,
    canvasSampling: flags.debug.sampling,
    canvasRenderingOptions: flags.debug.renderingOptions,
    arrowBindingOptimization: flags.features.edgeBinding,
    shortArrowheads: flags.features.shortArrowheads,
    ctrlMultiSelect: flags.features.ctrlMultiSelect,
    UIOptions: {
      defaultSidebar:
        !!props.resources && !flags.features.disableDefaultSidebar,
    },
    langCode: "zh-CN",
    theme: theme.value,
    onThemeChange: setPreference,
    children: createElement(
      MainMenu,
      null,
      ...(session.view?.access.role !== "viewer"
        ? [
            createElement(MainMenu.DefaultItems.LoadScene, { key: "load" }),
            createElement(MainMenu.DefaultItems.ClearCanvas, { key: "clear" }),
          ]
        : []),
      createElement(MainMenu.DefaultItems.Export, { key: "export" }),
      createElement(MainMenu.DefaultItems.SaveAsImage, { key: "image" }),
      createElement(MainMenu.DefaultItems.SearchMenu, { key: "search" }),
      createElement(MainMenu.DefaultItems.CommandPalette, { key: "commands" }),
      createElement(MainMenu.DefaultItems.Help, { key: "help" }),
      createElement(MainMenu.DefaultItems.ToggleTheme, {
        key: "theme",
        allowSystemTheme: true,
        theme: preference.value,
      }),
      ...(session.view?.access.role !== "viewer"
        ? [
            createElement(MainMenu.DefaultItems.ChangeCanvasBackground, {
              key: "background",
            }),
          ]
        : []),
    ),
    initialData: {
      ...(props.initialDocument?.scene ?? session.value),
      appState: {
        viewBackgroundColor: String(
          props.initialDocument?.scene.appState.viewBackgroundColor ??
            "#ffffff",
        ),
        currentItemFontFamily: flags.features.nunitoFont
          ? FONT_FAMILY.Nunito
          : FONT_FAMILY.Excalifont,
        currentItemRoughness: flags.features.formalLines ? 0 : 1,
        currentItemFillStyle: flags.features.solidFill ? "solid" : "hachure",
      },
    } as ExcalidrawInitialDataState,
    onInitialize: (api) => {
      editor = api;
      applySession();
    },
    onChange,
    onBeforeHistoryAction: () => {
      const preconditions = Object.fromEntries(
        editor!
          .getSceneElementsIncludingDeleted()
          .map((element) => [
            element.id,
            { version: element.version, versionNonce: element.versionNonce },
          ]),
      );

      historyPreconditions = preconditions;
      setTimeout(() => {
        if (historyPreconditions === preconditions)
          historyPreconditions = undefined;
      }, 500);
    },
    onPointerUpdate: (value) => {
      if (Date.now() - lastPresence < 60) return;
      lastPresence = Date.now();
      session.presence({
        pointer: value.pointer,
        selectedElementIds: editor?.getAppState().selectedElementIds ?? {},
      });
    },
    onLibraryChange: (items) => {
      if (
        libraryInjected &&
        !hydrating &&
        props.resources?.library &&
        JSON.stringify(items) !== JSON.stringify(props.resources.library.value)
      )
        props.resources.library.update([...items]);
    },
    onPaste: () => session.editable,
  });
}

watch(
  () => [
    settings.value.features.nunitoFont,
    settings.value.features.formalLines,
    settings.value.features.solidFill,
  ],
  (next, previous) => {
    if (!editor) return;
    const state = editor.getAppState();

    editor.updateScene({
      appState: {
        currentItemFontFamily:
          next[0] !== previous[0]
            ? next[0]
              ? FONT_FAMILY.Nunito
              : FONT_FAMILY.Excalifont
            : state.currentItemFontFamily,
        currentItemRoughness:
          next[1] !== previous[1]
            ? next[1]
              ? 0
              : 1
            : state.currentItemRoughness,
        currentItemFillStyle:
          next[2] !== previous[2]
            ? next[2]
              ? "solid"
              : "hachure"
            : state.currentItemFillStyle,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  },
);
watch(
  () => [settings.value, theme.value, preference.value],
  () => root?.render(createElement(CanvasEditor)),
  { deep: true },
);
onMounted(() => {
  root = createRoot(host.value!);
  root.render(createElement(CanvasEditor));
  unsubscribe = session.subscribe(applySession);
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("keydown", shortcut, true);
  void session.start();
  applySession();
});
onBeforeUnmount(() => {
  capture();
  alive = false;
  unsubscribe?.();
  root?.unmount();
  editor = undefined;
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("keydown", shortcut, true);
  void session
    .checkpoint()
    .catch((cause) => console.warn("协作草稿写入失败", cause));
});
</script>

<template>
  <div class="collaboration-editor">
    <div v-if="error" class="save-notice" :role="readOnly ? 'alert' : 'status'">
      <span>{{ error }}</span
      ><button type="button" @click="download">下载本地备份</button>
      <button type="button" @click="session.start()">重新连接</button>
      <button v-if="!dirty" type="button" @click="session.refresh()">
        重新读取
      </button>
    </div>
    <div
      ref="host"
      class="canvas-host"
      :class="
        settings.features.bottomToolbar ? 'toolbar-bottom' : 'toolbar-top'
      "
    />
  </div>
</template>

<style scoped>
.collaboration-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.canvas-host {
  flex: 1;
  min-height: 0;
}
.save-notice {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px 16px;
  background: var(--app-warning-bg);
  font-size: 13px;
}
.save-notice span {
  flex: 1;
}
</style>
