<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import QuietIcon from "~/components/QuietIcon.vue";

const props = defineProps<{ name: string; email: string; locked: boolean }>();
const emit = defineEmits<{ logout: [] }>();
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const open = ref(false);
const left = ref(8);
const bottom = ref(8);
const maxHeight = ref(200);
const close = (restore = true) => {
  open.value = false;
  if (restore) {
    trigger.value?.focus({ preventScroll: true });
  }
};
const show = async () => {
  if (props.locked) {
    return;
  }

  const bounds = trigger.value?.getBoundingClientRect();

  if (!bounds) {
    return;
  }

  left.value = Math.max(8, Math.min(bounds.left, window.innerWidth - 248));
  bottom.value = window.innerHeight - bounds.top + 4;
  maxHeight.value = Math.max(44, bounds.top - 12);
  open.value = true;
  await nextTick();
  menu.value?.focus({ preventScroll: true });
};
const keyDown = (event: KeyboardEvent) => {
  if (["Escape", "Tab"].includes(event.key)) {
    event.preventDefault();
    close();
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    menu.value
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }
};
const outside = (event: PointerEvent) => {
  const target = event.target as Node;

  if (
    open.value &&
    !trigger.value?.contains(target) &&
    !menu.value?.contains(target)
  ) {
    event.preventDefault();
    close();
  }
};
const logout = () => {
  close();
  emit("logout");
};
const reposition = () => {
  if (open.value) {
    close();
  }
};

watch(
  () => props.locked,
  (locked) => {
    if (locked) {
      close(false);
    }
  },
);
onMounted(() => {
  window.document.addEventListener("pointerdown", outside);
  window.addEventListener("resize", reposition);
});
onBeforeUnmount(() => {
  window.document.removeEventListener("pointerdown", outside);
  window.removeEventListener("resize", reposition);
});
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="account-trigger"
    aria-label="账号菜单"
    aria-haspopup="menu"
    :aria-controls="open ? 'sidebar-account-menu' : undefined"
    :aria-expanded="open"
    :disabled="locked"
    :title="name || email"
    @click="open ? close() : show()"
    @keydown.down.prevent="show"
    @keydown.up.prevent="show"
  >
    <span class="avatar">{{ (name || email).slice(0, 1).toUpperCase() }}</span>
    <span class="account-name">{{ name || email }}</span>
    <QuietIcon class="account-chevron" name="chevron" :size="16" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      id="sidebar-account-menu"
      ref="menu"
      class="account-menu"
      role="menu"
      aria-label="账号菜单"
      tabindex="-1"
      :style="{
        left: `${left}px`,
        bottom: `${bottom}px`,
        maxHeight: `${maxHeight}px`,
      }"
      @keydown="keyDown"
    >
      <div class="account-details">
        <strong>{{ name || email }}</strong
        ><span>{{ email }}</span>
      </div>
      <button type="button" role="menuitem" :disabled="locked" @click="logout">
        <QuietIcon name="logout" :size="16" />退出登录
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.account-trigger {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 44px;
  padding: 5px 7px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--app-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.account-trigger:hover,
.account-menu button:hover,
.account-menu button:focus-visible {
  background: var(--app-hover);
}
.account-trigger:focus-visible,
.account-menu button:focus-visible {
  outline: 2px solid var(--app-focus);
  outline-offset: -2px;
}
.avatar {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 50%;
  background: var(--app-selected);
  color: var(--app-selected-text);
  font-size: 12px;
  font-weight: 600;
}
.account-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.account-chevron {
  flex: none;
  transform: rotate(-90deg);
  color: var(--app-muted);
}
.account-menu {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  width: 240px;
  max-width: calc(100vw - 16px);
  overflow: auto;
  padding: 5px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface);
  color: var(--app-text);
  box-shadow: 0 6px 24px var(--app-shadow);
  outline: none;
}
.account-details {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.account-details strong {
  font-weight: 500;
}
.account-details span {
  color: var(--app-muted);
}
.account-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  width: 100%;
  padding: 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--app-text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
</style>
