<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from "vue";
import type {
  DirectoryNode,
  DirectoryPage,
  NodeRef,
} from "#shared/directory-contracts";
import { directoryApi } from "~/lib/directory-api";
import QuietIcon from "~/components/QuietIcon.vue";

const props = defineProps<{
  workspaceId: string;
  source?: NodeRef;
  sources?: readonly DirectoryNode[];
  catalogRevision?: number;
  blocked?: boolean;
  name: string;
  restoring?: boolean;
  busy?: boolean;
  error?: string;
  subtreeDepth?: number;
}>();
const emit = defineEmits<{ close: []; choose: [parentId: string | null] }>();
const dialog = ref<HTMLDialogElement>();
const page = ref<DirectoryPage>();
const trail = ref<DirectoryNode[]>([]);
const loading = ref(false);
const failure = ref("");
const parentId = computed(() => trail.value.at(-1)?.id ?? null);
const id = useId();
let generation = 0;
let returnFocus: HTMLElement | null = null;
const abort = new AbortController();
const read = async (append = false) => {
  const stamp = ++generation;

  loading.value = true;
  failure.value = "";
  try {
    const result = await directoryApi.children(
      props.workspaceId,
      parentId.value,
      append ? (page.value?.nextCursor ?? undefined) : undefined,
      abort.signal,
    );

    if (stamp !== generation) return;
    if (
      (props.catalogRevision !== undefined &&
        result.catalogRevision !== props.catalogRevision) ||
      (append &&
        page.value &&
        result.catalogRevision !== page.value.catalogRevision)
    )
      throw new Error("目录已更新，请关闭对话框并重新选择资源。");
    page.value =
      append && page.value
        ? { ...result, items: [...page.value.items, ...result.items] }
        : result;
  } catch (cause) {
    if (stamp === generation)
      failure.value = cause instanceof Error ? cause.message : "目录加载失败";
  } finally {
    if (stamp === generation) loading.value = false;
  }
};
const navigate = (item?: DirectoryNode, index?: number) => {
  if (loading.value || props.busy) return;
  if (item) trail.value.push(item);
  else trail.value = index === undefined ? [] : trail.value.slice(0, index + 1);
  page.value = undefined;
  void read();
};
const sourceFolders = computed(() =>
  props.sources
    ? props.sources
        .filter((item) => item.kind === "folder")
        .map((item) => ({ id: item.id, subtreeDepth: item.subtreeDepth }))
    : props.source?.kind === "folder"
      ? [{ id: props.source.id, subtreeDepth: props.subtreeDepth ?? 1 }]
      : [],
);
const unavailableReason = (item: DirectoryNode) => {
  if (item.kind !== "folder") return undefined;
  if (sourceFolders.value.some((source) => source.id === item.id))
    return "不能移动到自身或自己的子文件夹";
  if (
    sourceFolders.value.some((source) => item.depth + source.subtreeDepth > 5)
  )
    return "放入后文件夹将超过 5 层";

  return undefined;
};
const invalidDestination = computed(() => {
  const parent = trail.value.at(-1);
  const depth = parent?.kind === "folder" ? parent.depth : 0;

  return (
    trail.value.some((item) =>
      sourceFolders.value.some((source) => source.id === item.id),
    ) || sourceFolders.value.some((source) => depth + source.subtreeDepth > 5)
  );
});

onMounted(() => {
  returnFocus = document.activeElement as HTMLElement | null;
  dialog.value?.showModal();
  void read();
});
onBeforeUnmount(() => {
  generation++;
  abort.abort();
  dialog.value?.close();
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  else
    document
      .querySelector<HTMLElement>('[data-drop-zone="tree"] button')
      ?.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="move-dialog"
      :aria-labelledby="`${id}-title`"
      aria-modal="true"
      @cancel.prevent="!busy && emit('close')"
      @click.self="!busy && emit('close')"
      @keydown.stop
      @keyup.stop
      @copy.stop
      @cut.stop
      @paste.stop
    >
      <section class="move-card">
        <header>
          <h2 :id="`${id}-title`">
            {{ restoring ? "选择恢复位置" : "移动到" }}
          </h2>
          <button
            type="button"
            :disabled="busy"
            aria-label="关闭移动对话框"
            @click="emit('close')"
          >
            <QuietIcon name="close" :size="16" />
          </button>
        </header>
        <p class="move-description">
          {{ name }} ·
          {{
            restoring
              ? "原位置已不可用，请选择文件夹或根目录。"
              : "选择同一空间的目标文件夹。"
          }}
        </p>
        <nav aria-label="移动目标路径">
          <button type="button" :disabled="loading || busy" @click="navigate()">
            我的文件</button
          ><template v-for="(item, index) in trail" :key="item.id"
            ><span>/</span
            ><button
              type="button"
              :disabled="loading || busy"
              @click="navigate(undefined, index)"
            >
              {{ item.name }}
            </button></template
          >
        </nav>
        <div class="move-list" :aria-busy="loading">
          <p v-if="failure || error" role="alert">{{ failure || error }}</p>
          <button
            v-if="failure"
            type="button"
            :disabled="loading"
            @click="read()"
          >
            重新加载目录
          </button>
          <button
            v-for="item in page?.items.filter(
              (value) => value.kind === 'folder',
            ) ?? []"
            :key="item.id"
            type="button"
            :disabled="busy || loading || !!unavailableReason(item)"
            :title="unavailableReason(item)"
            :aria-label="`打开目标文件夹 ${item.name}`"
            @click="navigate(item)"
          >
            <QuietIcon name="folder" :size="16" /><span>{{ item.name }}</span
            ><QuietIcon name="chevron" :size="13" />
          </button>
          <p
            v-if="
              !loading &&
              !failure &&
              !page?.items.some((item) => item.kind === 'folder')
            "
          >
            此处没有可展开的文件夹
          </p>
          <button
            v-if="page?.nextCursor"
            type="button"
            :disabled="loading || busy"
            @click="read(true)"
          >
            加载更多目标文件夹
          </button>
          <p v-if="loading">正在加载…</p>
        </div>
        <footer>
          <button type="button" :disabled="busy" @click="emit('close')">
            取消</button
          ><button
            type="button"
            class="primary"
            :disabled="
              busy ||
              blocked ||
              loading ||
              !!failure ||
              !page ||
              invalidDestination
            "
            @click="emit('choose', parentId)"
          >
            {{ busy ? "处理中…" : restoring ? "恢复到这里" : "移动到这里" }}
          </button>
        </footer>
      </section>
    </dialog>
  </Teleport>
</template>

<style scoped>
.move-dialog {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 16px;
  border: 0;
  background: transparent;
  color: var(--app-text);
  box-sizing: border-box;
  font: inherit;
}
.move-dialog[open] {
  display: grid;
  place-items: center;
}
.move-dialog::backdrop {
  background: var(--app-backdrop);
}
.move-card {
  width: min(440px, 100%);
  max-height: calc(100dvh - 32px);
  display: flex;
  flex-direction: column;
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: 12px;
  box-shadow: 0 20px 70px var(--app-shadow);
}
header,
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
}
h2 {
  font-size: 15px;
  margin: 0;
}
button {
  font: inherit;
  font-size: 12px;
  color: inherit;
  cursor: pointer;
  border: 1px solid var(--app-border);
  border-radius: 5px;
  background: transparent;
  padding: 7px 9px;
}
button:hover {
  background: var(--app-hover);
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
button:focus-visible {
  outline: 2px solid var(--app-focus);
  outline-offset: -2px;
}
.move-description {
  font-size: 12px;
  color: var(--app-muted);
  margin: 0;
  padding: 0 16px 10px;
  overflow-wrap: anywhere;
}
nav {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 3px;
  padding: 8px 12px;
  border-block: 1px solid var(--app-border);
  font-size: 12px;
}
nav button {
  border: 0;
}
.move-list {
  overflow-y: auto;
  min-height: 160px;
  padding: 8px;
}
.move-list > button {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  text-align: left;
  border: 0;
  min-height: 34px;
}
.move-list > button span {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.move-list p {
  font-size: 12px;
  color: var(--app-muted);
  padding: 8px;
}
footer {
  justify-content: flex-end;
  border-top: 1px solid var(--app-border);
}
.primary {
  background: var(--app-selected);
}
</style>
