<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import type { CanvasSearchGroup } from "#shared/workspace-search";
import type { WorkspaceSearchController } from "~/composables/use-workspace-search";

const props = defineProps<{
  search: WorkspaceSearchController;
  selection?: { start: number; end: number };
}>();
const emit = defineEmits<{
  close: [];
  select: [canvas: CanvasSearchGroup["canvas"], elementId?: string];
}>();
const { query, groups, loading, complete, error, skipped } = props.search;
const dialog = ref<HTMLDialogElement>();
const input = ref<HTMLInputElement>();
const draft = ref(query.value);
const composing = ref(false);
const active = ref(0);
const items = computed(() =>
  groups.value.flatMap((group) => [
    {
      key: `${group.canvas.id}:title`,
      canvas: group.canvas,
      elementId: undefined as string | undefined,
    },
    ...group.matches.map((match) => ({
      key: `${group.canvas.id}:${match.elementId}`,
      canvas: group.canvas,
      elementId: match.elementId,
    })),
  ]),
);
const activeId = computed(() =>
  items.value[active.value]
    ? `workspace-search-result-${active.value}`
    : undefined,
);
const indexFor = (canvasId: string, elementId?: string) =>
  items.value.findIndex(
    (item) => item.canvas.id === canvasId && item.elementId === elementId,
  );
const resultId = (canvasId: string, elementId?: string) =>
  `workspace-search-result-${indexFor(canvasId, elementId)}`;
const select = (canvas: CanvasSearchGroup["canvas"], elementId?: string) => {
  if (!composing.value) emit("select", canvas, elementId);
};
const commit = (event: Event) => {
  draft.value = (event.target as HTMLInputElement).value;
  if (!composing.value && !(event as InputEvent).isComposing)
    props.search.setQuery(draft.value);
};
const compositionEnd = (event: CompositionEvent) => {
  composing.value = false;
  commit(event);
};
const close = () => {
  if (!composing.value) emit("close");
};
const keydown = (event: KeyboardEvent) => {
  if (composing.value || event.isComposing || event.keyCode === 229) return;
  if (event.key === "Escape") {
    event.preventDefault();
    close();
  } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    const length = items.value.length;

    if (length)
      active.value =
        (active.value + (event.key === "ArrowDown" ? 1 : -1) + length) % length;
    void nextTick(() =>
      document
        .getElementById(activeId.value ?? "")
        ?.scrollIntoView({ block: "nearest" }),
    );
  } else if (event.key === "Enter") {
    event.preventDefault();
    const item = items.value[active.value];

    if (item) select(item.canvas, item.elementId);
  }
};
const focusInput = () => input.value?.focus();

watch(query, (value) => {
  if (!composing.value) draft.value = value;
  active.value = 0;
});
watch(items, (value) => {
  active.value = Math.min(active.value, Math.max(0, value.length - 1));
});
onMounted(() => {
  dialog.value?.showModal();
  input.value?.focus();
  const end = draft.value.length;

  input.value?.setSelectionRange(
    props.selection?.start ?? end,
    props.selection?.end ?? end,
  );
});
onBeforeUnmount(() => dialog.value?.close());
defineExpose({ focusInput });
</script>

<template>
  <dialog
    ref="dialog"
    data-testid="workspace-search-panel"
    class="workspace-search-dialog"
    aria-labelledby="workspace-search-heading"
    @cancel.prevent="close"
    @keydown.stop="keydown"
    @click.self="close"
  >
    <div class="search-card">
      <header>
        <h2 id="workspace-search-heading">搜索当前工作空间</h2>
        <button type="button" aria-label="关闭搜索" @click="close">×</button>
      </header>
      <input
        ref="input"
        data-testid="workspace-search-input"
        :value="draft"
        class="search-input"
        type="search"
        autocomplete="off"
        spellcheck="false"
        placeholder="搜索画布标题、正文或 Frame 名称"
        aria-label="搜索当前工作空间"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls="workspace-search-results"
        :aria-activedescendant="activeId"
        @input="commit"
        @compositionstart="composing = true"
        @compositionend="compositionEnd"
      />
      <p class="search-scope">搜索全部非回收站画布，不搜索文件夹名称</p>
      <div
        id="workspace-search-results"
        class="search-results"
        role="listbox"
        aria-label="搜索结果"
        :aria-busy="loading"
      >
        <section
          v-for="group in groups"
          :key="group.canvas.id"
          class="result-group"
          role="group"
          :aria-label="group.canvas.name"
        >
          <button
            :id="resultId(group.canvas.id)"
            data-testid="workspace-search-option"
            :data-canvas-id="group.canvas.id"
            type="button"
            class="result-title"
            :class="{ active: active === indexFor(group.canvas.id) }"
            role="option"
            :aria-selected="active === indexFor(group.canvas.id)"
            @mouseenter="active = indexFor(group.canvas.id)"
            @click="select(group.canvas)"
          >
            <span class="result-kind">画布</span
            ><span class="canvas-heading"
              ><strong>{{ group.canvas.name }}</strong
              ><small v-if="group.canvas.folderPath">{{
                group.canvas.folderPath
              }}</small></span
            ><span v-if="group.titleMatched" class="title-match">标题匹配</span>
          </button>
          <button
            v-for="match in group.matches"
            :id="resultId(group.canvas.id, match.elementId)"
            :key="match.elementId"
            data-testid="workspace-search-option"
            :data-canvas-id="group.canvas.id"
            :data-element-id="match.elementId"
            type="button"
            class="result-match"
            :class="{
              active: active === indexFor(group.canvas.id, match.elementId),
            }"
            role="option"
            :aria-selected="
              active === indexFor(group.canvas.id, match.elementId)
            "
            @mouseenter="active = indexFor(group.canvas.id, match.elementId)"
            @click="select(group.canvas, match.elementId)"
          >
            <span class="result-kind">{{
              match.kind === "frame" ? "Frame" : "文字"
            }}</span>
            <span class="result-snippet"
              >{{ match.snippet.slice(0, match.matchStart)
              }}<mark>{{
                match.snippet.slice(match.matchStart, match.matchEnd)
              }}</mark
              >{{ match.snippet.slice(match.matchEnd) }}</span
            >
          </button>
        </section>
      </div>
      <footer role="status" aria-live="polite">
        <span v-if="!query.trim()">输入关键词开始搜索</span>
        <span v-else-if="loading">正在搜索全部画布…</span>
        <span v-else-if="error">搜索未完成：{{ error }}</span>
        <span v-else-if="complete && !groups.length && !skipped.length"
          >没有找到匹配内容</span
        >
        <span v-else-if="complete">搜索完成 · {{ groups.length }} 张画布</span>
        <span v-if="skipped.length">{{ skipped.length }} 张画布暂不可搜索</span>
        <button
          v-if="error || (complete && skipped.length)"
          type="button"
          @click="search.retry"
        >
          重新搜索
        </button>
      </footer>
    </div>
  </dialog>
</template>

<style scoped>
.workspace-search-dialog {
  width: min(680px, calc(100vw - 28px));
  max-height: min(720px, calc(100dvh - 48px));
  padding: 0;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  color: var(--app-text);
  background: var(--app-surface);
  box-shadow: 0 20px 80px #0003;
}
.workspace-search-dialog::backdrop {
  background: #0005;
}
.search-card {
  display: flex;
  flex-direction: column;
  max-height: min(720px, calc(100dvh - 48px));
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 8px;
}
h2 {
  margin: 0;
  font-size: 16px;
}
button {
  font: inherit;
  color: inherit;
  cursor: pointer;
}
header button {
  border: 0;
  background: none;
  font-size: 24px;
  line-height: 1;
}
.search-input {
  margin: 8px 18px 0;
  padding: 12px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  color: var(--app-text);
  background: var(--app-bg);
  font: inherit;
  min-width: 0;
}
.search-input:focus {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.search-scope {
  margin: 10px 18px;
  color: var(--app-muted);
  font-size: 12px;
}
.search-results {
  overflow: auto;
  min-height: 40px;
  padding: 0 8px;
}
.result-group {
  margin-bottom: 8px;
}
.result-title,
.result-match {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px;
  text-align: left;
  border: 0;
  border-radius: 7px;
  background: transparent;
}
.result-title {
  border-top: 1px solid var(--app-border);
  border-radius: 0;
}
.result-title strong,
.result-snippet {
  overflow-wrap: anywhere;
  min-width: 0;
}
.result-kind,
.title-match {
  color: var(--app-muted);
  font-size: 11px;
  flex-shrink: 0;
}
.canvas-heading {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.canvas-heading small {
  color: var(--app-muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.result-kind {
  width: 36px;
}
.title-match {
  margin-left: auto;
}
.active,
.result-title:hover,
.result-match:hover {
  background: var(--app-accent-soft, #8882);
}
mark {
  background: #f3d36a;
  color: #252015;
  border-radius: 2px;
}
footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--app-border);
  color: var(--app-muted);
  font-size: 12px;
}
footer button {
  border: 1px solid var(--app-border);
  border-radius: 5px;
  background: var(--app-surface);
  padding: 4px 8px;
}
</style>
