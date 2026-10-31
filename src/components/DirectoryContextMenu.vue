<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { DirectoryNode } from "#shared/directory-contracts";

const props = defineProps<{
  item: DirectoryNode;
  x: number;
  y: number;
  locked: boolean;
  favoriteContext?: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
}>();
const emit = defineEmits<{
  close: [];
  action: [
    action:
      | "favorite"
      | "rename"
      | "delete"
      | "move"
      | "up"
      | "down"
      | "create-canvas"
      | "create-folder"
      | "locate",
  ];
}>();
const menu = ref<HTMLElement>();
// Measure inside the viewport; a provisional off-screen menu can scroll the page.
const left = ref(8);
const top = ref(8);
const items = () => [
  ...(menu.value?.querySelectorAll<HTMLButtonElement>(
    "button:not(:disabled)",
  ) ?? []),
];
const key = (event: KeyboardEvent) => {
  event.stopPropagation();
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    emit("close");

    return;
  }

  const entries = items();
  const current = entries.indexOf(document.activeElement as HTMLButtonElement);
  const index =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? entries.length - 1
        : event.key === "ArrowDown"
          ? (current + 1) % entries.length
          : event.key === "ArrowUp"
            ? (current - 1 + entries.length) % entries.length
            : -1;

  if (index < 0) return;
  event.preventDefault();
  entries[index]?.focus();
};
const outside = (event: PointerEvent) => {
  if (event.target instanceof Node && !menu.value?.contains(event.target))
    emit("close");
};
const dismiss = () => emit("close");

onMounted(async () => {
  await nextTick();
  const bounds = menu.value?.getBoundingClientRect();

  if (bounds) {
    left.value = Math.max(
      8,
      Math.min(props.x, window.innerWidth - bounds.width - 8),
    );
    top.value = Math.max(
      8,
      Math.min(props.y, window.innerHeight - bounds.height - 8),
    );
  }

  await nextTick();
  if (!menu.value) return;
  items()[0]?.focus({ preventScroll: true });
  window.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", dismiss);
});
onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", dismiss);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="menu"
      class="directory-menu"
      role="menu"
      :aria-label="`${item.kind === 'folder' ? '文件夹' : '画布'} ${item.name} 的操作`"
      :style="{ left: `${left}px`, top: `${top}px` }"
      @keydown="key"
      @contextmenu.prevent
    >
      <template v-if="item.kind === 'folder' && !favoriteContext">
        <button
          role="menuitem"
          :disabled="locked"
          @click="emit('action', 'create-canvas')"
        >
          新建画布
        </button>
        <button
          role="menuitem"
          :disabled="locked || item.depth >= 5"
          :title="
            item.depth >= 5 ? '文件夹最多支持 5 层，仍可新建画布' : undefined
          "
          @click="emit('action', 'create-folder')"
        >
          新建文件夹
        </button>
      </template>
      <button
        v-if="favoriteContext"
        role="menuitem"
        :disabled="locked"
        @click="emit('action', 'locate')"
      >
        定位原位置
      </button>
      <button
        role="menuitem"
        :disabled="locked"
        @click="emit('action', 'favorite')"
      >
        {{ item.favorite ? "取消收藏" : "收藏" }}
      </button>
      <button
        role="menuitem"
        :disabled="locked || !canMoveUp"
        @click="emit('action', 'up')"
      >
        ↑ 上移
      </button>
      <button
        role="menuitem"
        :disabled="locked || !canMoveDown"
        @click="emit('action', 'down')"
      >
        ↓ 下移
      </button>
      <button
        role="menuitem"
        :disabled="locked"
        @click="emit('action', 'move')"
      >
        移动到…
      </button>
      <button
        role="menuitem"
        :disabled="locked"
        @click="emit('action', 'rename')"
      >
        重命名
      </button>
      <button
        role="menuitem"
        class="danger"
        :disabled="locked"
        @click="emit('action', 'delete')"
      >
        删除{{ item.kind === "folder" ? "文件夹" : "画布" }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.directory-menu {
  box-sizing: border-box;
  position: fixed;
  z-index: 1200;
  min-width: 168px;
  max-width: calc(100vw - 16px);
  max-height: calc(100dvh - 16px);
  overflow-y: auto;
  padding: 5px;
  border: 1px solid var(--app-border);
  border-radius: 9px;
  background: var(--app-surface);
  color: var(--app-text);
  box-shadow: 0 8px 28px #0002;
}
button {
  display: block;
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 8px 12px;
  text-align: left;
  border-radius: 5px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
button:hover,
button:focus-visible {
  background: var(--app-hover);
  outline: 2px solid transparent;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
.danger {
  color: var(--app-danger);
}
</style>
