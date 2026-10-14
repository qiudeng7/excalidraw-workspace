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
  AppState,
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
import { isRichTextV1 } from "@excalidraw/excalidraw/rich-text";
import { wins, canonical } from "#shared/collaboration/merge";
import type { Element } from "#shared/collaboration/types";
import { collaborationSession } from "~/lib/collaboration/session";
import type { CanvasResources } from "~/lib/canvasResources";
import type { EditorHandle } from "~/lib/editor";
import { defaultEditorTool } from "~/lib/editorTools";
import {
  captureEditorHistory,
  restoreEditorHistory,
} from "~/lib/editorHistory";

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
const textRecovery = ref<ExcalidrawElement>();
const textRecoveryKey = `excalidraw-rich-text-recovery:${props.scope}:${props.canvasId}`;

function preserveText(element: ExcalidrawElement) {
  textRecovery.value = JSON.parse(JSON.stringify(element));
  try {
    localStorage.setItem(textRecoveryKey, JSON.stringify(element));
  } catch (cause) {
    console.warn("富文本恢复副本无法写入本地存储", cause);
  }
}

function clearTextRecovery() {
  textRecovery.value = undefined;
  try {
    localStorage.removeItem(textRecoveryKey);
  } catch (cause) {
    console.warn("无法清除富文本恢复副本", cause);
  }
}

async function recoverText() {
  if (!editor || !session.editable || !textRecovery.value) return;
  const source = textRecovery.value;
  const copy = {
    ...source,
    id: crypto.randomUUID(),
    containerId: null,
    boundElements: null,
    groupIds: [],
    frameId: null,
    x: source.x + 24,
    y: source.y + 24,
    isDeleted: false,
    version: 1,
    versionNonce: Math.floor(Math.random() * 0x7fffffff),
    updated: Date.now(),
    created: Date.now(),
  };

  editor.updateScene({
    elements: [...editor.getSceneElementsIncludingDeleted(), copy] as never,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  capture();
  try {
    await session.flush();
    clearTextRecovery();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "恢复副本同步失败";
  }
}

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
const entry = props.resources?.canvases.get(props.canvasId);
const initialTool =
  (entry?.editorContext?.activeTool as AppState["activeTool"] | undefined) ??
  defaultEditorTool(navigator);
const initialHistory = entry?.editorContext?.history;
const historyGeneration = entry?.historyGeneration;
let historyRestorePending = true;
const initialViewGeneration = session.viewGeneration;
let confirmedThisMount = false;
const canEdit = () => confirmedThisMount && session.editable;

function applySession() {
  if (!alive) return;
  if (session.viewGeneration > initialViewGeneration) confirmedThisMount = true;
  error.value = session.message;
  dirty.value = session.dirty;
  readOnly.value = !canEdit();
  emit(
    "status",
    confirmedThisMount || session.message
      ? session.statusText
      : "正在校验版本…",
  );
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
    canEdit(),
    session.view?.access.viewMode,
  ]);

  if (nextRenderState !== renderState) {
    renderState = nextRenderState;
    root?.render(createElement(CanvasEditor));
  }

  if (!editor || !session.view || !confirmedThisMount) return;
  const editing = editor.getAppState().editingTextElement;

  if (editing) {
    const local = editor
      .getSceneElementsIncludingDeleted()
      .find((element) => element.id === editing.id);
    const remote = (session.view.scene.elements as Element[]).find(
      (element) => element.id === editing.id,
    );

    if (
      local?.type === "text" &&
      local.richText &&
      (!session.editable ||
        (remote &&
          wins(remote, local as unknown as Element) &&
          canonical(remote) !== canonical(local)))
    ) {
      preserveText(local);
      applying = true;
      try {
        flushSync(() => editor!.cancelTextEditing());
      } finally {
        applying = false;
      }
    }
  }

  if (previousReadOnly && canEdit()) {
    flushSync(() => root?.render(createElement(CanvasEditor)));
    flushSync(() =>
      editor!.updateScene({
        appState: { viewModeEnabled: false },
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
  }

  previousReadOnly = !canEdit();
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
    const firstInstall = !initialized.value;

    if (firstInstall) {
      editor.history.clear();
      initialized.value = true;
    }

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
    if (firstInstall) emit("ready");
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
  if (!alive || !initialized.value) return;
  if (
    historyRestorePending &&
    editor &&
    canEdit() &&
    !appState.viewModeEnabled
  ) {
    historyRestorePending = false;
    restoreEditorHistory(
      editor,
      initialHistory,
      session.value,
      session.view?.epoch ?? "",
    );
  }

  if (applying) return;
  if (entry)
    entry.editorContext = {
      ...entry.editorContext,
      viewModeEnabled: appState.viewModeEnabled,
      activeTool: canEdit()
        ? { ...appState.activeTool }
        : (entry.editorContext?.activeTool ?? initialTool),
      viewport: {
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        zoom: { ...appState.zoom },
      },
    };
  const previousElements = displayedElements;

  displayedElements = elements;
  if (
    appState.openSidebar?.name === "default" &&
    (!appState.openSidebar.tab || appState.openSidebar.tab === "library")
  )
    void ensureLibrary();
  if (canEdit()) {
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
  if (
    editor &&
    entry?.editorContext &&
    !historyRestorePending &&
    historyGeneration === entry.historyGeneration
  )
    entry.editorContext.history = captureEditorHistory(
      editor,
      session.view?.epoch ?? "",
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

function downloadFile(content: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadTextRecovery() {
  const source = textRecovery.value;

  if (!source || source.type !== "text") return;
  // Export only the retained local document. Do not capture/flush the denied room.
  const element = {
    ...source,
    containerId: null,
    boundElements: null,
    groupIds: [],
    frameId: null,
    autoResize: false,
    isDeleted: false,
  };
  const content = serializeAsJSON(
    [element],
    { viewBackgroundColor: "#ffffff" },
    {},
    "local",
  );

  downloadFile(
    content,
    `${session.view?.name ?? props.initialDocument?.name ?? "画布"}-文字恢复副本.excalidraw`,
  );
}

function download() {
  capture();
  const value =
    session.value.elements.length || session.view
      ? session.value
      : props.initialDocument?.scene;

  downloadFile(
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: location.origin,
      ...value,
    }),
    `${session.view?.name ?? props.initialDocument?.name ?? "画布"}-本地备份.excalidraw`,
  );
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
    customColorPaletteStorageKey: props.userId
      ? `workspace:color-palette:v1:${encodeURIComponent(props.userId)}`
      : undefined,
    handleKeyboardGlobally: false,
    syncReadOnly: !canEdit(),
    viewModeEnabled: canEdit() ? undefined : true,
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
        ...entry?.editorContext?.viewport,
        activeTool: initialTool,
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
    onPaste: () => canEdit(),
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
  try {
    const raw = localStorage.getItem(textRecoveryKey);
    const saved = raw && raw.length < 2000000 ? JSON.parse(raw) : undefined;

    if (saved?.type === "text" && isRichTextV1(saved.richText))
      textRecovery.value = saved;
  } catch (cause) {
    console.warn("读取富文本恢复副本失败", cause);
  }

  root = createRoot(host.value!);
  root.render(createElement(CanvasEditor));
  unsubscribe = session.subscribe(applySession);
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("keydown", shortcut, true);
  void session.start();
  applySession();
});
onBeforeUnmount(() => {
  const active = editor?.getAppState().editingTextElement;

  if (active && session.dirty) {
    const local = editor
      ?.getSceneElementsIncludingDeleted()
      .find((element) => element.id === active.id);

    if (local?.type === "text" && local.richText) preserveText(local);
  }

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
    <div v-if="textRecovery" class="text-recovery" role="status">
      <span>文字编辑已结束，本地富文本副本已保留。</span>
      <button v-if="!readOnly" type="button" @click="recoverText">
        恢复为新文字
      </button>
      <button type="button" @click="downloadTextRecovery">下载文字副本</button>
      <button type="button" @click="clearTextRecovery">忽略</button>
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
.text-recovery {
  position: absolute;
  bottom: 5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  max-width: calc(100% - 2rem);
  padding: 0.6rem 0.9rem;
  border: 1px solid var(--app-border);
  border-radius: 0.6rem;
  background: var(--app-surface);
  color: var(--app-text);
  box-shadow: 0 2px 8px #0001;
  font-size: 0.8rem;
}
.text-recovery button {
  flex-shrink: 0;
  font: inherit;
  background: none;
  border: 0;
  color: inherit;
  cursor: pointer;
  text-decoration: underline;
}

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
