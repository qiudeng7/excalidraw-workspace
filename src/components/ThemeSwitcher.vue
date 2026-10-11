<script setup lang="ts">
import type { ThemePreference } from "../composables/useTheme";

const { preference, setPreference } = useTheme();

function changeTheme(event: Event) {
  setPreference((event.target as HTMLSelectElement).value as ThemePreference);
}
</script>

<template>
  <label class="theme-switcher" title="外观主题">
    <QuietIcon
      :name="
        preference === 'system'
          ? 'monitor'
          : preference === 'dark'
            ? 'moon'
            : 'sun'
      "
      :size="15"
    />
    <select :value="preference" aria-label="外观主题" @change="changeTheme">
      <option value="light">浅色</option>
      <option value="dark">深色</option>
      <option value="system">跟随系统</option>
    </select>
  </label>
</template>

<style scoped>
.theme-switcher {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 5px;
  flex: none;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  padding: 0 7px;
  height: 30px;
  color: var(--app-muted);
  background: var(--app-surface);
  font-size: 11px;
}
.theme-switcher select {
  min-width: 0;
  height: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.theme-switcher:focus-within {
  outline: 2px solid var(--app-focus);
  outline-offset: 2px;
}
.theme-switcher select:focus {
  outline: none;
}
.theme-switcher option {
  background: var(--app-surface);
  color: var(--app-text);
}
</style>
