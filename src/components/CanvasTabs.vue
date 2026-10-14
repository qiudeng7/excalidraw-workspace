<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { CanvasMeta } from "#shared/contracts";
import QuietIcon from "~/components/QuietIcon.vue";

const props = defineProps<{
  tabs: readonly CanvasMeta[];
  activeId?: string;
  locked: boolean;
  closingLocked: boolean;
}>();
const emit = defineEmits<{ select: [id: string]; close: [id: string] }>();
const strip = ref<HTMLElement>();
const tabId = (id: string) => `canvas-tab-${id}`;

function button(id: string) {
  return document.getElementById(tabId(id));
}

function handleKey(event: KeyboardEvent, index: number) {
  let target: number;

  switch (event.key) {
    case "ArrowLeft":
      target = (index + props.tabs.length - 1) % props.tabs.length;
      break;
    case "ArrowRight":
      target = (index + 1) % props.tabs.length;
      break;
    case "Home":
      target = 0;
      break;
    case "End":
      target = props.tabs.length - 1;
      break;
    case "Delete":
      event.preventDefault();
      if (!props.closingLocked) emit("close", props.tabs[index]!.id);

      return;
    default:
      return;
  }

  event.preventDefault();
  if (props.locked) return;
  const tab = props.tabs[target]!;

  button(tab.id)?.focus();
  emit("select", tab.id);
}

watch(
  () => props.activeId,
  async (id) => {
    await nextTick();
    if (id) button(id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  },
);

watch(
  () => props.tabs.map((tab) => tab.id),
  async (ids, previous) => {
    const focused = document.activeElement;
    const focusedId =
      focused?.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
    const restoreFocus =
      strip.value?.contains(focused) &&
      focusedId &&
      previous.includes(focusedId) &&
      !ids.includes(focusedId);

    if (!restoreFocus) return;
    await nextTick();
    const next =
      props.activeId && ids.includes(props.activeId) ? props.activeId : ids[0];

    if (next) button(next)?.focus();
    else document.getElementById("open-canvas-sidebar")?.focus();
  },
);
</script>

<template>
  <div
    ref="strip"
    class="canvas-tabs"
    role="tablist"
    aria-label="打开的画布"
    @keydown.stop
    @keyup.stop
  >
    <div
      v-for="(tab, index) in tabs"
      :key="tab.id"
      class="canvas-tab"
      :class="{ active: tab.id === activeId }"
      :data-tab-id="tab.id"
      role="presentation"
    >
      <button
        :id="tabId(tab.id)"
        class="canvas-tab-select"
        type="button"
        role="tab"
        :aria-selected="tab.id === activeId"
        aria-controls="canvas-tab-panel"
        :tabindex="tab.id === activeId || (!activeId && index === 0) ? 0 : -1"
        :disabled="locked"
        :title="tab.name"
        @click="emit('select', tab.id)"
        @keydown="handleKey($event, index)"
      >
        <QuietIcon name="canvas" :size="14" />
        <span>{{ tab.name }}</span>
      </button>
      <button
        class="canvas-tab-close"
        type="button"
        :aria-label="`关闭画布标签 ${tab.name}`"
        :title="`关闭 ${tab.name}`"
        :disabled="closingLocked"
        :tabindex="tab.id === activeId ? 0 : -1"
        @click="emit('close', tab.id)"
      >
        <QuietIcon name="close" :size="12" />
      </button>
    </div>
    <span v-if="!tabs.length" class="canvas-tabs-empty">未打开画布</span>
  </div>
</template>

<style scoped>
.canvas-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
}
.canvas-tab {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  max-width: 230px;
  min-width: 88px;
  height: 32px;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--app-muted);
}
.canvas-tab:hover {
  background: var(--app-hover);
}
.canvas-tab.active {
  background: var(--app-surface);
  border-color: var(--line);
  color: var(--app-text);
}
.canvas-tab-select {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 7px 4px 7px 9px;
  flex: 1;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.canvas-tab-select svg {
  flex: none;
  opacity: 0.7;
}
.canvas-tab-select span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.canvas-tab-close {
  display: grid;
  place-items: center;
  flex: none;
  width: 22px;
  height: 22px;
  margin: 0 4px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  color: var(--app-muted);
  background: transparent;
  cursor: pointer;
}
.canvas-tab-close:hover {
  color: var(--app-text);
  background: var(--app-hover);
}
.canvas-tab-select:focus-visible,
.canvas-tab-close:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.canvas-tab button:disabled {
  cursor: default;
  opacity: 0.5;
}
.canvas-tabs-empty {
  color: var(--app-muted);
  font-size: 12px;
  white-space: nowrap;
}
@media (max-width: 760px) {
  .canvas-tab {
    max-width: 170px;
    min-width: 80px;
    height: 30px;
  }
  .canvas-tab-select {
    font-size: 11px;
    gap: 5px;
    padding-left: 7px;
  }
  .canvas-tab-close {
    width: 24px;
    height: 26px;
    margin: 0 2px;
  }
}
</style>
