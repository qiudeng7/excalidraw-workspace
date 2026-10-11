<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
} from "vue";
import type { ThemePreference } from "../composables/useTheme";

const { preference, setPreference } = useTheme();
const options: { value: ThemePreference; label: string; icon: string }[] = [
  { value: "light", label: "浅色", icon: "sun" },
  { value: "dark", label: "深色", icon: "moon" },
  { value: "system", label: "跟随系统", icon: "monitor" },
];
const currentIndex = computed(() =>
  options.findIndex((option) => option.value === preference.value),
);
const current = computed(() => options[currentIndex.value]!);
const id = useId();
const picker = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const list = ref<HTMLUListElement>();
const open = ref(false);
const activeIndex = ref(0);

function closeMenu(returnFocus = false) {
  open.value = false;
  if (returnFocus) trigger.value?.focus();
}

async function openMenu(index = currentIndex.value) {
  activeIndex.value = index;
  open.value = true;
  await nextTick();
  list.value?.focus();
}

function selectTheme(index: number) {
  setPreference(options[index]!.value);
  closeMenu(true);
}

function handleTriggerKey(event: KeyboardEvent) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  void openMenu(
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : currentIndex.value,
  );
}

function handleListKey(event: KeyboardEvent) {
  if (event.key === "Tab") {
    closeMenu(true);

    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu(true);

    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectTheme(activeIndex.value);

    return;
  }

  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  activeIndex.value =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : Math.max(
            0,
            Math.min(
              options.length - 1,
              activeIndex.value + (event.key === "ArrowDown" ? 1 : -1),
            ),
          );
}

function dismissMenu(event: PointerEvent) {
  if (open.value && !picker.value?.contains(event.target as Node)) closeMenu();
}

function handleFocusOut(event: FocusEvent) {
  if (
    event.relatedTarget &&
    !picker.value?.contains(event.relatedTarget as Node)
  )
    closeMenu();
}

watch(preference, () => {
  activeIndex.value = currentIndex.value;
});
onMounted(() => document.addEventListener("pointerdown", dismissMenu));
onBeforeUnmount(() => document.removeEventListener("pointerdown", dismissMenu));
</script>

<template>
  <div ref="picker" class="theme-switcher" @focusout="handleFocusOut">
    <div class="theme-picker">
      <button
        ref="trigger"
        type="button"
        class="theme-trigger"
        :class="{ expanded: open }"
        :aria-label="`外观主题：${current.label}`"
        aria-haspopup="listbox"
        :aria-expanded="open"
        :aria-controls="`${id}-options`"
        title="外观主题"
        @click="open ? closeMenu() : openMenu()"
        @keydown.stop="handleTriggerKey"
      >
        <QuietIcon :name="current.icon" :size="15" />
        <span>{{ current.label }}</span>
        <svg
          class="theme-chevron"
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
        v-if="open"
        :id="`${id}-options`"
        ref="list"
        class="theme-options"
        role="listbox"
        tabindex="0"
        aria-label="外观主题"
        :aria-activedescendant="`${id}-option-${activeIndex}`"
        @keydown.stop="handleListKey"
      >
        <li
          v-for="(option, index) in options"
          :id="`${id}-option-${index}`"
          :key="option.value"
          role="option"
          :aria-selected="option.value === preference"
          :class="{
            active: activeIndex === index,
            chosen: option.value === preference,
          }"
          @pointermove="activeIndex = index"
          @click="selectTheme(index)"
        >
          <QuietIcon :name="option.icon" :size="15" />
          <span>{{ option.label }}</span>
          <QuietIcon
            v-if="option.value === preference"
            name="check"
            :size="15"
          />
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.theme-switcher {
  display: inline-flex;
  flex: none;
}
.theme-picker {
  position: relative;
  display: inline-flex;
}
.theme-trigger {
  display: flex;
  align-items: center;
  gap: 7px;
  box-sizing: border-box;
  min-width: 100px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface);
  color: var(--app-muted);
  font: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}
.theme-trigger > svg {
  flex: none;
}
.theme-trigger > span {
  flex: 1;
  white-space: nowrap;
}
.theme-trigger:hover {
  background: var(--app-hover);
  border-color: var(--app-border-strong);
}
.theme-trigger.expanded {
  border-color: var(--app-focus);
  box-shadow: 0 0 0 2px var(--app-focus-ring);
}
.theme-trigger:focus-visible {
  outline: 2px solid var(--app-focus);
  outline-offset: 2px;
}
.theme-chevron {
  width: 12px;
  height: 12px;
  transition: transform 0.15s;
}
.expanded .theme-chevron {
  transform: rotate(180deg);
}
.theme-options {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 50;
  box-sizing: border-box;
  width: 168px;
  max-width: calc(100vw - 24px);
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid var(--app-border);
  border-radius: 7px;
  background: var(--app-surface);
  box-shadow: 0 6px 24px var(--app-shadow);
  outline: none;
}
.theme-options li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  box-sizing: border-box;
  padding: 9px 8px;
  border-radius: 4px;
  color: var(--app-muted);
  font-size: 12px;
  cursor: pointer;
}
.theme-options li > svg {
  flex: none;
}
.theme-options li > span {
  flex: 1;
  white-space: nowrap;
}
.theme-options li.active {
  background: var(--app-hover);
}
.theme-options li.chosen {
  background: var(--app-selected);
  color: var(--app-selected-text);
}
.theme-options li.chosen > span {
  font-weight: 500;
}
.theme-options:focus-visible li.active {
  box-shadow: inset 0 0 0 1px var(--app-border-strong);
}
@media (prefers-reduced-motion: reduce) {
  .theme-chevron {
    transition: none;
  }
}
</style>
