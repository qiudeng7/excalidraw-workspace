<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { CanvasMeta } from "#shared/contracts";
import type { CanvasMenuTarget } from "~/composables/use-canvas-context-menu";

const props = defineProps<{
  canvas: CanvasMeta;
  target: CanvasMenuTarget;
  locked: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
}>();
const emit = defineEmits<{
  close: [restoreFocus: boolean];
  pin: [];
  move: [offset: number];
  rename: [];
  delete: [];
}>();
const menu = ref<HTMLElement>();
const left = ref(8);
const top = ref(8);
const items = () => [
  ...(menu.value?.querySelectorAll<HTMLButtonElement>(
    "button:not(:disabled)",
  ) ?? []),
];
const handleKey = (event: KeyboardEvent) => {
  event.stopPropagation();
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    emit("close", true);

    return;
  }

  const entries = items();
  const current = entries.indexOf(document.activeElement as HTMLButtonElement);
  let index: number;

  if (event.key === "Home") index = 0;
  else if (event.key === "End") index = entries.length - 1;
  else if (event.key === "ArrowDown") index = (current + 1) % entries.length;
  else if (event.key === "ArrowUp")
    index = (current - 1 + entries.length) % entries.length;
  else return;
  event.preventDefault();
  entries[index]?.focus();
};

watch(
  () => props.target,
  async (target) => {
    await nextTick();
    const bounds = menu.value?.getBoundingClientRect();

    if (!bounds || target !== props.target) return;
    left.value = Math.max(
      8,
      Math.min(props.target.x, window.innerWidth - bounds.width - 8),
    );
    top.value = Math.max(
      8,
      Math.min(props.target.y, window.innerHeight - bounds.height - 8),
    );
    await nextTick();
    if (target === props.target)
      (items()[0] ?? menu.value)?.focus({ preventScroll: true });
  },
  { immediate: true, flush: "post" },
);
</script>

<template>
  <Teleport to="body">
    <div
      ref="menu"
      class="canvas-context-menu"
      data-canvas-context-menu
      role="menu"
      tabindex="-1"
      :aria-label="`画布 ${canvas.name} 的操作`"
      :style="{ left: `${left}px`, top: `${top}px` }"
      @keydown="handleKey"
      @contextmenu.prevent
    >
      <button role="menuitem" :disabled="locked" @click="emit('pin')">
        {{ canvas.pinned ? "取消置顶" : "置顶" }}
      </button>
      <button
        role="menuitem"
        aria-label="上移"
        :disabled="locked || !canMoveUp"
        @click="emit('move', -1)"
      >
        ↑ 上移
      </button>
      <button
        role="menuitem"
        aria-label="下移"
        :disabled="locked || !canMoveDown"
        @click="emit('move', 1)"
      >
        ↓ 下移
      </button>
      <button role="menuitem" :disabled="locked" @click="emit('rename')">
        重命名
      </button>
      <button
        role="menuitem"
        class="danger"
        :disabled="locked"
        @click="emit('delete')"
      >
        删除画布
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.canvas-context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  max-width: calc(100vw - 16px);
  max-height: calc(100dvh - 16px);
  overflow-y: auto;
  padding: 5px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-surface);
  box-shadow: 0 8px 28px #0002;
}
button {
  display: block;
  width: 100%;
  padding: 9px 12px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--app-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
button:hover,
button:focus-visible {
  background: var(--app-hover);
}
button:focus-visible {
  outline: 2px solid var(--app-focus);
  outline-offset: -2px;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
button.danger {
  color: var(--app-danger);
}
</style>
