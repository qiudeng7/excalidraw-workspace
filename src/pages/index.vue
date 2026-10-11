<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import AccountGate from "../components/AccountGate.vue";
import QuietIcon from "../components/QuietIcon.vue";
import { accountApi } from "../lib/accountApi";
import { workspaceApi } from "../lib/workspaceApi";
import { cancelAppDialog, confirmDialog, promptDialog } from "../lib/dialogs";
import type { EditorHandle } from "../lib/editor";
import { useOperation } from "../composables/useOperation";
import {
  useAccountSession,
  type AccountSessionController,
} from "../composables/useAccountSession";
import { useCanvasDocument } from "../composables/useCanvasDocument";
import { useWorkspaceNavigation } from "../composables/useWorkspaceNavigation";
import {
  useWorkspaceDirectory,
  type WorkspaceDirectoryController,
} from "../composables/useWorkspaceDirectory";
import { useWorkspacePicker } from "../composables/useWorkspacePicker";
import {
  useCanvasReorder,
  type CanvasReorderController,
} from "../composables/useCanvasReorder";

const editor = ref<EditorHandle>();
const saveBarrier = {
  flush: async () => {
    await editor.value?.flush();
  },
};
const sidebarOpen = ref(!window.matchMedia("(max-width: 760px)").matches);
const saveShortcut = /Mac|iPhone|iPad/.test(navigator.platform)
  ? "⌘ S"
  : "Ctrl S";
// Owner and account callbacks run on mount/actions, after these ports are bound.
let account: AccountSessionController;
let directory: WorkspaceDirectoryController;
const navigationController = useWorkspaceNavigation(workspaceApi);
const canvasDocument = useCanvasDocument({
  api: workspaceApi,
  ownerId: () => {
    if (!account.user.value) throw new Error("请先登录");

    return account.user.value.id;
  },
  onLoaded: () => {
    if (window.matchMedia("(max-width: 760px)").matches)
      sidebarOpen.value = false;
  },
});
// Reorder is bound after directory creation. This reactive slot makes the lock safe even
// if a controller reads it while the composition root is still initializing.
const reorderSlot = shallowRef<CanvasReorderController>();
const operation = useOperation(() => !!reorderSlot.value?.drag.value);
const { busy, error, run } = operation;
const interactionLocked = computed(
  () => busy.value || !!reorderSlot.value?.drag.value,
);

directory = useWorkspaceDirectory({
  api: workspaceApi,
  navigationController,
  canvasDocument,
  editor: saveBarrier,
  interactionLocked,
  run,
  dialogs: { prompt: promptDialog, confirm: confirmDialog },
});
const reordering = useCanvasReorder({
  canvases: directory.canvases,
  locked: directory.directoryLocked,
  reorder: directory.reorderCanvas,
});

reorderSlot.value = reordering;
account = useAccountSession({
  api: accountApi,
  editor: saveBarrier,
  loadWorkspaces: directory.loadWorkspaces,
  run,
  reportError: operation.reportError,
  clearWorkspace: () => {
    canvasDocument.reset();
    directory.reset();
    navigationController.reset();
  },
});
const {
  bootstrap,
  user,
  settingsResource,
  starting,
  settingsBusy,
  initialize,
  authenticated,
  logout,
  toggleRegistration,
  flushSettings,
} = account;
const { document, library, saveState, setSaveState } = canvasDocument;
const {
  workspaces,
  canvases,
  workspaceId,
  currentWorkspace,
  directoryStale,
  directoryLocked,
  refreshDirectory,
  loadWorkspaces,
  selectCanvas,
  createWorkspace,
  renameWorkspace,
  deleteWorkspace,
  createCanvas,
  renameCanvas,
  deleteCanvas,
} = directory;
const { navigationNotice, clearNotice } = navigationController;
const {
  drag,
  moveCanvas,
  startDrag,
  dragMove,
  finishDrag,
  cancelDrag,
  dragKey,
} = reordering;
const picker = useWorkspacePicker({
  workspaces,
  workspaceId,
  locked: interactionLocked,
  sidebarOpen,
  select: (id) => selectWorkspace(id),
});
const {
  workspacePicker,
  workspaceTrigger,
  workspaceList,
  workspaceMenuOpen,
  activeWorkspaceIndex,
  closeWorkspaceMenu,
  openWorkspaceMenu,
  handleWorkspaceTriggerKey,
  handleWorkspaceListKey,
  handleWorkspaceFocusOut,
  setActiveWorkspace,
} = picker;

async function selectWorkspace(id: string) {
  if (interactionLocked.value) return;
  closeWorkspaceMenu(true);
  await directory.selectWorkspace(id);
}

function closeActionMenu(event: MouseEvent) {
  const button = (event.target as HTMLElement).closest("button");

  if (button && !button.disabled)
    button.closest("details")?.removeAttribute("open");
}

onBeforeRouteLeave(async () => {
  if (!user.value) return true;
  try {
    await saveBarrier.flush();
    await flushSettings();

    return true;
  } catch (cause) {
    operation.reportError(
      cause instanceof Error ? cause.message : "尚未保存，暂时无法跳转。",
    );

    return false;
  }
});
onBeforeUnmount(cancelAppDialog);
</script>

<template>
  <section v-if="starting" class="loading">
    <span class="loading-mark" /><span>正在打开你的空间…</span>
  </section>
  <section v-else-if="!bootstrap" class="loading">
    <p role="alert">{{ error }}</p>
    <button @click="initialize">重试连接</button>
  </section>
  <AccountGate
    v-else-if="!user"
    :bootstrap="bootstrap"
    @authenticated="authenticated"
    @refresh="initialize"
  />
  <section v-else class="draw-page" aria-label="Excalidraw 画布">
    <button
      v-if="sidebarOpen"
      class="sidebar-backdrop"
      aria-label="关闭侧边栏"
      @click="sidebarOpen = false"
    />
    <aside
      v-if="sidebarOpen"
      id="workspace-sidebar"
      class="workspace-sidebar"
      aria-label="账户与工作空间"
    >
      <div class="sidebar-heading">
        <span class="workspace-brand"
          ><span class="brand-symbol"
            ><QuietIcon name="canvas" :size="17" /></span
          >画布空间</span
        ><button
          class="icon-button"
          title="收起侧边栏"
          aria-label="收起侧边栏"
          @click="sidebarOpen = false"
        >
          <QuietIcon name="panel" :size="17" />
        </button>
      </div>
      <div class="workspace-controls">
        <div class="section-label">
          <label id="workspace-picker-label" for="workspace-select"
            >工作空间</label
          >
          <details class="action-menu">
            <summary aria-label="工作空间操作" title="工作空间操作">
              <QuietIcon name="more" :size="17" />
            </summary>
            <div class="menu-popover" @click="closeActionMenu">
              <button :disabled="interactionLocked" @click="createWorkspace">
                <QuietIcon name="plus" :size="15" />新建工作空间</button
              ><button
                :disabled="interactionLocked || !workspaceId"
                @click="renameWorkspace"
              >
                <QuietIcon name="edit" :size="15" />重命名</button
              ><button
                class="danger"
                :disabled="interactionLocked || !workspaceId"
                @click="deleteWorkspace"
              >
                <QuietIcon name="trash" :size="15" />删除工作空间
              </button>
            </div>
          </details>
        </div>
        <div
          ref="workspacePicker"
          class="workspace-picker"
          @focusout="handleWorkspaceFocusOut"
        >
          <button
            id="workspace-select"
            ref="workspaceTrigger"
            class="workspace-select-wrap"
            :class="{ expanded: workspaceMenuOpen }"
            :disabled="interactionLocked || !workspaces.length"
            aria-haspopup="listbox"
            :aria-expanded="workspaceMenuOpen"
            aria-controls="workspace-options"
            aria-labelledby="workspace-picker-label workspace-current-name"
            @click="
              workspaceMenuOpen ? closeWorkspaceMenu() : openWorkspaceMenu()
            "
            @keydown="handleWorkspaceTriggerKey"
          >
            <QuietIcon name="folder" :size="16" /><span
              id="workspace-current-name"
              :title="currentWorkspace?.name"
              >{{ currentWorkspace?.name ?? "选择工作空间" }}</span
            ><svg
              class="workspace-chevron"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="m3 4.5 3 3 3-3"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <ul
            v-if="workspaceMenuOpen"
            id="workspace-options"
            ref="workspaceList"
            class="workspace-options"
            role="listbox"
            tabindex="0"
            aria-labelledby="workspace-picker-label"
            :aria-activedescendant="`workspace-option-${activeWorkspaceIndex}`"
            @keydown="handleWorkspaceListKey"
          >
            <li
              v-for="(workspace, index) in workspaces"
              :id="`workspace-option-${index}`"
              :key="workspace.id"
              role="option"
              :aria-selected="workspace.id === workspaceId"
              :aria-disabled="interactionLocked"
              :class="{
                active: activeWorkspaceIndex === index,
                chosen: workspace.id === workspaceId,
              }"
              :title="workspace.name"
              @pointermove="setActiveWorkspace(index)"
              @click="selectWorkspace(workspace.id)"
            >
              <QuietIcon name="folder" :size="15" /><span>{{
                workspace.name
              }}</span
              ><QuietIcon
                v-if="workspace.id === workspaceId"
                name="check"
                :size="15"
              />
            </li>
          </ul>
        </div>
      </div>
      <div class="canvas-heading">
        <span
          >画布 <span class="count">{{ canvases.length }}</span></span
        ><button
          class="icon-button"
          title="新建画布"
          aria-label="新建画布"
          :disabled="directoryLocked || !workspaceId"
          @click="createCanvas"
        >
          <QuietIcon name="plus" :size="16" />
        </button>
      </div>
      <ul class="canvas-list">
        <li
          v-for="(canvas, index) in canvases"
          :key="canvas.id"
          :data-canvas-id="canvas.id"
          :class="{
            selected: document?.id === canvas.id,
            dragging: drag?.id === canvas.id,
            'drop-target':
              drag && drag.targetId === canvas.id && drag.id !== canvas.id,
          }"
        >
          <button
            class="drag-handle"
            :aria-label="`调整画布 ${canvas.name} 的顺序`"
            title="拖动排序；方向键上移或下移"
            :disabled="busy || directoryStale"
            @pointerdown="startDrag($event, canvas)"
            @pointermove="dragMove"
            @pointerup="finishDrag"
            @pointercancel="cancelDrag"
            @lostpointercapture="cancelDrag"
            @keydown="dragKey($event, canvas)"
          >
            <svg viewBox="0 0 12 16" aria-hidden="true">
              <circle
                v-for="dot in 6"
                :key="dot"
                :cx="dot % 2 ? 4 : 8"
                :cy="Math.ceil(dot / 2) * 4"
                r="1"
                fill="currentColor"
              />
            </svg>
          </button>
          <button
            class="canvas-name"
            :title="canvas.name"
            :aria-current="document?.id === canvas.id ? 'page' : undefined"
            :disabled="interactionLocked"
            @click="selectCanvas(canvas.id)"
          >
            <QuietIcon name="canvas" :size="16" /><span>{{ canvas.name }}</span>
          </button>
          <details class="action-menu canvas-menu">
            <summary
              :aria-label="`画布 ${canvas.name} 的操作`"
              title="画布操作"
            >
              <QuietIcon name="more" :size="16" />
            </summary>
            <div class="menu-popover" @click="closeActionMenu">
              <button
                :aria-label="`上移画布 ${canvas.name}`"
                :disabled="directoryLocked || index === 0"
                @click="moveCanvas(canvas, -1)"
              >
                ↑ 上移</button
              ><button
                :aria-label="`下移画布 ${canvas.name}`"
                :disabled="directoryLocked || index === canvases.length - 1"
                @click="moveCanvas(canvas, 1)"
              >
                ↓ 下移</button
              ><button
                :aria-label="`重命名画布 ${canvas.name}`"
                :disabled="directoryLocked"
                @click="renameCanvas(canvas)"
              >
                <QuietIcon name="edit" :size="15" />重命名</button
              ><button
                class="danger"
                :aria-label="`删除画布 ${canvas.name}`"
                :disabled="directoryLocked"
                @click="deleteCanvas(canvas)"
              >
                <QuietIcon name="trash" :size="15" />删除画布
              </button>
            </div>
          </details>
        </li>
      </ul>
      <p v-if="!canvases.length" class="sidebar-empty">
        {{ workspaceId ? "这个空间还没有画布" : "还没有工作空间" }}
      </p>
      <div class="sidebar-bottom">
        <div v-if="user.role === 'admin'" class="admin-settings">
          <div class="section-label">
            <strong>管理设置</strong><span class="admin-badge">ADMIN</span>
          </div>
          <label class="registration-switch"
            ><span><span>开放注册</span><small>允许新用户创建账户</small></span
            ><input
              type="checkbox"
              :checked="bootstrap.registrationEnabled"
              :disabled="settingsBusy"
              @change="toggleRegistration" /><span
              class="switch-track"
              aria-hidden="true"
          /></label>
        </div>
        <div class="account-info">
          <span class="avatar">{{
            (user.name || user.email).slice(0, 1).toUpperCase()
          }}</span>
          <div class="account-text">
            <strong>{{ user.name || user.email }}</strong
            ><small :title="user.email">{{ user.email }}</small>
          </div>
          <button
            class="icon-button"
            title="退出登录"
            aria-label="退出登录"
            :disabled="interactionLocked"
            @click="logout"
          >
            <QuietIcon name="logout" :size="17" />
          </button>
        </div>
      </div>
    </aside>
    <div class="draw-content">
      <header class="canvas-header">
        <button
          class="sidebar-toggle icon-button"
          :aria-expanded="sidebarOpen"
          aria-controls="workspace-sidebar"
          aria-label="切换工作空间侧边栏"
          title="工作空间"
          @click="sidebarOpen = !sidebarOpen"
        >
          <QuietIcon name="panel" :size="18" />
        </button>
        <div class="breadcrumb">
          <span class="workspace-crumb">{{ currentWorkspace?.name }}</span
          ><span class="crumb-divider">/</span
          ><span class="document-name">{{ document?.name ?? "我的画布" }}</span>
        </div>
        <div class="header-right">
          <ThemeSwitcher />
          <span
            class="save-state"
            :class="{ saved: saveState === '已保存' && !busy }"
            role="status"
            ><span class="status-dot" />{{ busy ? "处理中…" : saveState }}</span
          ><button
            class="save-button"
            :disabled="interactionLocked || !document"
            title="保存画布 · Ctrl / ⌘ S"
            @click="editor?.saveManually()"
          >
            <QuietIcon name="cloud" :size="15" /><span>保存</span
            ><kbd>{{ saveShortcut }}</kbd>
          </button>
        </div>
      </header>
      <div v-if="navigationNotice" class="navigation-notice" role="status">
        <span>{{ navigationNotice }}</span
        ><button
          class="icon-button"
          aria-label="关闭最近位置提示"
          @click="clearNotice"
        >
          <QuietIcon name="close" :size="16" />
        </button>
      </div>
      <div v-if="directoryStale" class="operation-error" role="alert">
        <span>画布列表尚未确认，目录操作已暂停。</span
        ><button :disabled="busy" @click="run(refreshDirectory)">
          重新加载列表
        </button>
      </div>
      <div v-if="error" class="operation-error" role="alert">
        <span>{{ error }}</span
        ><button
          v-if="!document"
          :disabled="directoryLocked"
          @click="run(loadWorkspaces)"
        >
          重新加载</button
        ><button
          class="icon-button"
          aria-label="关闭提示"
          @click="operation.reportError('')"
        >
          <QuietIcon name="close" :size="16" />
        </button>
      </div>
      <div
        v-if="
          settingsResource &&
          ['unavailable', 'error', 'conflict'].includes(
            settingsResource.state.status,
          )
        "
        class="settings-notice"
        role="alert"
      >
        <span>{{ settingsResource.state.error }}</span
        ><button
          v-if="!settingsResource.state.cloudConflict"
          @click="settingsResource.retry()"
        >
          {{
            settingsResource.state.ready ? "重试同步设置" : "重新读取设置"
          }}</button
        ><template v-else
          ><button @click="settingsResource.useCloud()">采用云端设置</button
          ><button @click="settingsResource.keepLocal()">
            保存当前设置
          </button></template
        >
      </div>
      <div
        v-if="document && library && settingsResource"
        class="draw-editor"
        :inert="busy"
      >
        <ExcalidrawCanvas
          :key="`${user.id}:${document.id}`"
          ref="editor"
          :document="document"
          :library="library"
          :user-id="user.id"
          :user-settings="settingsResource.state.settings"
          :settings-ready="settingsResource.state.ready"
          :settings-status="settingsResource.state.status"
          :settings-error="settingsResource.state.error"
          :settings-configured="settingsResource.state.configured"
          :settings-conflict="!!settingsResource.state.cloudConflict"
          @settings-change="settingsResource.update($event)"
          @settings-retry="settingsResource.retry()"
          @settings-reload="settingsResource.load()"
          @settings-use-cloud="settingsResource.useCloud()"
          @settings-keep-local="settingsResource.keepLocal()"
          @save-state="setSaveState($event)"
        />
      </div>
      <div v-else class="loading">
        <template v-if="busy">正在加载画布…</template
        ><template v-else-if="!workspaces.length"
          ><p>创建工作空间，开始整理你的画布。</p>
          <button
            class="empty-create"
            :disabled="interactionLocked"
            @click="createWorkspace"
          >
            新建工作空间
          </button></template
        ><template v-else-if="!canvases.length"
          ><p>这个工作空间还没有画布。</p>
          <button
            class="empty-create"
            :disabled="directoryLocked"
            @click="createCanvas"
          >
            新建画布
          </button></template
        ><template v-else
          ><p>暂时无法加载画布，请重试。</p>
          <button :disabled="directoryLocked" @click="run(loadWorkspaces)">
            重新加载
          </button></template
        >
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 16px;
  background: var(--app-warning-bg);
  color: var(--app-warning);
  font-size: 12px;
}
.settings-notice span {
  flex: 1;
}
.settings-notice button {
  border: 1px solid var(--app-warning-border);
  background: var(--app-surface);
}

.drag-handle {
  display: grid;
  place-items: center;
  flex: none;
  width: 18px;
  height: 30px;
  padding: 0 !important;
  color: var(--app-subtle);
  touch-action: none;
  cursor: grab;
}
.drag-handle svg {
  width: 12px;
  height: 16px;
}
.drag-handle:active {
  cursor: grabbing;
}
.canvas-list li.dragging {
  opacity: 0.5;
}
.canvas-list li.drop-target {
  box-shadow: inset 0 -2px var(--app-focus);
}
.canvas-name {
  padding-left: 5px !important;
}
.sidebar-empty {
  padding: 0 8px;
  color: var(--app-subtle);
  font-size: 11px;
}
.navigation-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--app-hover);
  padding: 8px 16px;
  font-size: 12px;
  color: var(--app-muted);
}
.navigation-notice span {
  flex: 1;
}
.empty-create {
  padding: 10px 18px;
  background: var(--app-accent);
  color: var(--app-on-accent);
}
.empty-create:hover {
  background: var(--app-accent-hover);
}

.draw-page {
  --text: var(--app-text);
  --muted: var(--app-subtle);
  --line: var(--app-border);
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
  background: var(--app-surface);
  color: var(--text);
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}
.draw-content {
  position: relative;
  isolation: isolate;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.draw-editor {
  flex: 1;
  min-height: 0;
}
.loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  font-size: 13px;
  color: var(--app-muted);
}
.loading-mark {
  width: 18px;
  height: 18px;
  border: 2px solid var(--app-border);
  border-top-color: var(--app-focus);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.workspace-sidebar {
  box-sizing: border-box;
  flex: none;
  width: 248px;
  display: flex;
  flex-direction: column;
  padding: 0 14px;
  background: var(--app-sidebar);
  border-right: 1px solid var(--line);
  z-index: 20;
  overflow: auto;
}
.sidebar-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 68px;
  flex: none;
  padding: 0 4px;
}
.workspace-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.03em;
}
.brand-symbol {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  background: var(--app-accent);
  color: var(--app-on-accent);
  border-radius: 6px;
}
.workspace-controls {
  margin-top: 15px;
  margin-bottom: 24px;
}
.section-label,
.canvas-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-muted);
  font-size: 11px;
  letter-spacing: 0.04em;
}
.section-label {
  padding: 0 8px;
  margin-bottom: 8px;
}
.section-label strong {
  font-weight: 500;
}
.workspace-picker {
  position: relative;
}
.workspace-select-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  padding: 0 11px;
  height: 38px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface);
  color: var(--app-muted);
  text-align: left;
}
.workspace-select-wrap > svg {
  flex: none;
}
.workspace-select-wrap > span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  color: var(--app-text);
}
.workspace-select-wrap:hover {
  background: var(--app-hover);
  border-color: var(--app-border-strong);
}
.workspace-select-wrap.expanded {
  border-color: var(--app-focus);
  box-shadow: 0 0 0 2px var(--app-focus-ring);
}
.workspace-chevron {
  width: 12px;
  height: 12px;
  transition: transform 0.15s;
}
.expanded .workspace-chevron {
  transform: rotate(180deg);
}
.workspace-options {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 37;
  box-sizing: border-box;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: 7px;
  box-shadow: 0 6px 24px var(--app-shadow);
  max-height: min(280px, calc(100dvh - 180px));
  overflow-y: auto;
  outline: none;
  overscroll-behavior: contain;
}
.workspace-options li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 8px;
  border-radius: 4px;
  color: var(--app-muted);
  font-size: 12px;
  cursor: pointer;
}
.workspace-options li > svg {
  flex: none;
}
.workspace-options li > span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-muted);
}
.workspace-options li.active {
  background: var(--app-hover);
}
.workspace-options li.chosen > span {
  font-weight: 500;
  color: var(--app-selected-text);
}
.workspace-options:focus-visible li.active {
  box-shadow: inset 0 0 0 1px var(--app-border-strong);
}
.workspace-options li[aria-disabled="true"] {
  opacity: 0.5;
  cursor: wait;
}
.canvas-heading {
  padding: 0 8px;
  margin-bottom: 7px;
}
.count {
  margin-left: 5px;
  color: var(--app-subtle);
  font-size: 10px;
}
.canvas-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-height: 110px;
}
.canvas-list li {
  display: flex;
  align-items: center;
  border-radius: 5px;
  min-height: 37px;
  padding-right: 3px;
  color: var(--app-muted);
}
.canvas-list li:hover {
  background: var(--app-hover);
}
.canvas-list .selected {
  background: var(--app-selected);
  color: var(--app-selected-text);
}
.canvas-name {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1;
  min-width: 0;
  text-align: left;
  padding: 10px 10px !important;
  font-size: 13px !important;
  background: none !important;
}
.canvas-name svg {
  flex: none;
}
.canvas-name span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.canvas-menu {
  flex: none;
  color: var(--app-subtle);
}
.action-menu {
  position: relative;
}
.action-menu summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 4px;
  outline: none;
}
.action-menu summary::-webkit-details-marker {
  display: none;
}
.action-menu summary:hover,
.action-menu[open] summary {
  background: var(--app-hover);
  color: var(--app-muted);
}
.action-menu summary:focus-visible {
  outline: 2px solid var(--app-focus);
  outline-offset: 1px;
}
.action-menu[open] {
  z-index: 35;
}
.menu-popover {
  position: absolute;
  right: 0;
  top: 30px;
  min-width: 158px;
  padding: 4px;
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  box-shadow: 0 6px 24px var(--app-shadow);
  border-radius: 7px;
  z-index: 36;
}
.menu-popover button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 9px 8px;
  font-size: 11px;
  white-space: nowrap;
}
.menu-popover .danger {
  color: var(--app-danger);
}
.sidebar-bottom {
  margin-top: 26px;
  flex: none;
}
.admin-settings {
  padding: 16px 0 19px;
  border-top: 1px solid var(--line);
}
.admin-badge {
  font-size: 8px;
  letter-spacing: 0.09em;
  color: var(--app-subtle);
}
.registration-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 0;
  font-size: 12px;
  cursor: pointer;
}
.registration-switch > span:first-child {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 5px;
}
.registration-switch small {
  font-size: 10px;
  color: var(--app-muted);
}
.registration-switch input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
  clip-path: inset(50%);
}
.switch-track {
  flex: none;
  width: 28px;
  height: 16px;
  border-radius: 10px;
  background: var(--app-switch);
  position: relative;
  pointer-events: none;
}
.switch-track::after {
  content: "";
  position: absolute;
  width: 12px;
  height: 12px;
  top: 2px;
  left: 2px;
  border-radius: 50%;
  background: var(--app-on-accent);
  transition: transform 0.15s;
  box-shadow: 0 1px 3px #0002;
}
.registration-switch input:checked + .switch-track {
  background: var(--app-switch-active);
}
.registration-switch input:checked + .switch-track::after {
  transform: translateX(12px);
}
.registration-switch input:focus-visible + .switch-track {
  outline: 2px solid var(--app-switch-active);
  outline-offset: 3px;
}
.registration-switch input:disabled + .switch-track {
  opacity: 0.5;
}
.account-info {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 17px 5px;
  border-top: 1px solid var(--line);
}
.avatar {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 50%;
  background: var(--app-selected);
  color: var(--app-muted);
  font-size: 11px;
  font-weight: 600;
}
.account-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.account-text strong,
.account-text small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-text strong {
  font-size: 12px;
  font-weight: 500;
}
.account-text small {
  font-size: 10px;
  color: var(--app-muted);
}
.canvas-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
  height: 51px;
  box-sizing: border-box;
  padding: 0 20px 0 13px;
  border-bottom: 1px solid var(--line);
  color: var(--app-muted);
}
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  min-width: 0;
  flex: 1;
}
.workspace-crumb {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  max-width: 200px;
  color: var(--app-muted);
}
.crumb-divider {
  color: var(--app-subtle);
}
.document-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--app-text);
  font-weight: 500;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 18px;
  flex: none;
}
.save-state {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--app-muted);
}
.status-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--app-warning);
}
.saved .status-dot {
  background: var(--app-switch-active);
}
.save-button {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px !important;
  color: var(--app-muted) !important;
}
.save-button kbd {
  font-family: inherit;
  font-size: 9px;
  color: var(--app-subtle);
  padding-left: 5px;
}
.icon-button {
  display: grid;
  place-items: center;
  width: 27px;
  height: 27px;
  flex: none;
  padding: 0 !important;
  color: var(--app-subtle) !important;
}
.sidebar-toggle {
  color: var(--app-muted) !important;
}
button {
  cursor: pointer;
  border: 0;
  background: transparent;
  border-radius: 4px;
  padding: 6px 9px;
  font: inherit;
  color: inherit;
}
button:hover {
  background: var(--app-hover);
}
button:disabled {
  opacity: 0.45;
  cursor: wait;
}
button:focus-visible {
  outline: 2px solid var(--app-focus);
  outline-offset: 2px;
}
.operation-error {
  padding: 10px 16px;
  background: var(--app-danger-bg);
  color: var(--app-danger);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.operation-error span {
  flex: 1;
}
.sidebar-backdrop {
  display: none;
}
@media (max-width: 1000px) {
  .header-right {
    gap: 10px;
  }
  .save-button kbd {
    display: none;
  }
  .workspace-crumb {
    max-width: 120px;
  }
}
@media (max-width: 760px) {
  .workspace-sidebar {
    position: absolute;
    inset: 0 auto 0 0;
    width: min(280px, 85vw);
    box-shadow: 8px 0 24px #0002;
    z-index: 40;
  }
  .sidebar-backdrop {
    display: block;
    position: absolute;
    inset: 0;
    border: 0;
    border-radius: 0;
    background: var(--app-backdrop);
    z-index: 39;
  }
  .canvas-header {
    padding-inline: 10px;
    height: 47px;
    gap: 8px;
  }
  .workspace-crumb,
  .crumb-divider {
    display: none;
  }
  .header-right {
    gap: 6px;
  }
  .save-state {
    max-width: 90px;
    overflow: hidden;
    white-space: nowrap;
    font-size: 9px;
  }
  .save-button {
    padding: 5px;
  }
  .save-button span {
    display: none;
  }
  .menu-popover {
    max-width: 200px;
  }
  .account-info {
    padding-bottom: calc(17px + env(safe-area-inset-bottom));
  }
}
</style>
