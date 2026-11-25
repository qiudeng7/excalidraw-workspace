<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId } from "vue";
import QuietIcon from "./QuietIcon.vue";
import ReleaseNotes from "./ReleaseNotes.vue";

const props = defineProps<{ owner: string }>();
const emit = defineEmits<{
  close: [];
  shown: [owner: string];
  failed: [owner: string, error: unknown];
}>();
const dialog = ref<HTMLDialogElement>();
const id = useId();
const owner = props.owner;
let returnFocus: HTMLElement | null = null;

onMounted(() => {
  returnFocus = document.activeElement as HTMLElement | null;
  try {
    dialog.value!.showModal();
  } catch (error) {
    emit("failed", owner, error);
  }
});
onBeforeUnmount(() => {
  dialog.value?.close();
  const target =
    returnFocus?.isConnected && returnFocus !== document.body
      ? returnFocus
      : document.querySelector<HTMLElement>(".excalidraw");

  target?.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="release-dialog"
      aria-modal="true"
      :aria-labelledby="`${id}-title`"
      @cancel.prevent="emit('close')"
      @keydown.stop
      @keyup.stop
      @copy.stop
      @cut.stop
      @paste.stop
    >
      <header>
        <h2 :id="`${id}-title`">更新公告</h2>
        <button type="button" aria-label="关闭更新公告" @click="emit('close')">
          <QuietIcon name="close" />
        </button>
      </header>
      <div class="release-body">
        <ReleaseNotes @shown="emit('shown', owner)" />
      </div>
      <footer>
        <small>可在设置中的更新日志回看。</small
        ><button
          type="button"
          class="release-continue"
          autofocus
          @click="emit('close')"
        >
          继续绘图
        </button>
      </footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.release-dialog {
  box-sizing: border-box;
  width: min(600px, calc(100% - 32px));
  max-height: calc(100dvh - 32px);
  margin: auto;
  padding: 0;
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: var(--app-surface);
  color: var(--app-text);
  font: inherit;
  box-shadow: 0 24px 90px var(--app-shadow);
}
.release-dialog[open] {
  display: flex;
  flex-direction: column;
}
.release-dialog::backdrop {
  background: var(--app-backdrop);
  backdrop-filter: blur(3px);
}
header,
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
  padding: 16px 24px;
}
header {
  border-bottom: 1px solid var(--app-border);
}
h2 {
  margin: 0;
  font-size: 21px;
}
header button {
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--app-muted);
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
}
header button:hover {
  background: var(--app-hover);
}
.release-body {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 8px 24px;
}
footer {
  border-top: 1px solid var(--app-border);
}
small {
  color: var(--app-muted);
}
.release-continue {
  flex-shrink: 0;
  padding: 9px 16px;
  background: var(--app-accent);
  color: var(--app-on-accent);
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}
.release-continue:hover {
  background: var(--app-accent-hover);
}
@media (max-width: 480px) {
  header,
  footer {
    padding: 12px 16px;
  }
  .release-body {
    padding: 4px 16px;
  }
  footer {
    flex-wrap: wrap;
  }
}
</style>
