<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId } from "vue";
import type { RecycleEntry } from "#shared/contracts";
import { api } from "~/lib/api";
import { confirmDialog } from "~/lib/dialogs";
import QuietIcon from "~/components/QuietIcon.vue";

const props = defineProps<{ refresh: () => Promise<void> }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const entries = ref<RecycleEntry[]>([]);
const busy = ref(false);
const loaded = ref(false);
const error = ref("");
const id = useId();
let returnFocus: HTMLElement | null = null;

async function load() {
  entries.value = (
    await api<{ entries: RecycleEntry[] }>("/api/recycle-bin")
  ).entries;
  loaded.value = true;
  await props.refresh();
}

async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "回收站操作失败，请重试";
  } finally {
    busy.value = false;
  }
}

function close() {
  if (!busy.value) emit("close");
}

async function change(entry: RecycleEntry, purge = false) {
  if (busy.value) return;
  if (
    purge &&
    !(await confirmDialog({
      title: "彻底删除",
      message: `彻底删除「${entry.name}」${entry.kind === "workspace" ? "及其中所有画布" : ""}？此操作无法恢复。`,
      confirmLabel: "彻底删除",
      danger: true,
    }))
  )
    return;
  await run(async () => {
    await api(
      `/api/recycle-bin/${entry.kind}/${encodeURIComponent(entry.id)}`,
      {
        method: purge ? "DELETE" : "POST",
        body: JSON.stringify(purge ? { confirm: true } : {}),
      },
    );
    await load();
  });
}

function remaining(entry: RecycleEntry) {
  return Math.max(
    0,
    Math.ceil((Date.parse(entry.expiresAt) - Date.now()) / 86400000),
  );
}

onMounted(() => {
  returnFocus = document.activeElement as HTMLElement | null;
  dialog.value?.showModal();
  void run(load);
});
onBeforeUnmount(() => {
  dialog.value?.close();
  if (returnFocus?.isConnected) returnFocus.focus();
});
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="recycle-dialog"
      aria-modal="true"
      :aria-labelledby="`${id}-title`"
      @cancel.prevent="close"
      @click.self="close"
      @keydown.stop
      @keyup.stop
      @copy.stop
      @cut.stop
      @paste.stop
    >
      <section class="recycle-card">
        <header>
          <div>
            <h2 :id="`${id}-title`">回收站</h2>
            <p>画布和工作空间保留 30 天，之后将彻底删除。</p>
          </div>
          <button
            class="icon-button"
            aria-label="关闭回收站"
            :disabled="busy"
            @click="close"
          >
            <QuietIcon name="close" />
          </button>
        </header>
        <div class="recycle-content" :aria-busy="busy">
          <div v-if="error" class="recycle-error" role="alert">
            {{ error
            }}<button :disabled="busy" @click="run(load)">重新加载</button>
          </div>
          <p v-if="!loaded && !error" class="recycle-empty">正在加载…</p>
          <div v-else-if="loaded && !entries.length" class="recycle-empty">
            <QuietIcon name="trash" :size="32" />
            <p>回收站是空的</p>
          </div>
          <ul v-else aria-label="回收项目">
            <li v-for="entry in entries" :key="`${entry.kind}:${entry.id}`">
              <QuietIcon
                :name="entry.kind === 'workspace' ? 'folder' : 'canvas'"
                :size="20"
              />
              <div class="recycle-details">
                <strong :title="entry.name">{{ entry.name }}</strong
                ><small
                  >{{
                    entry.kind === "workspace"
                      ? "工作空间 · 包含其中画布"
                      : entry.workspaceName
                  }}
                  · {{ new Date(entry.deletedAt).toLocaleDateString() }} 删除 ·
                  剩余 {{ remaining(entry) }} 天</small
                >
              </div>
              <div class="recycle-actions">
                <button
                  :disabled="busy"
                  :aria-label="`恢复 ${entry.name}`"
                  @click="change(entry)"
                >
                  恢复</button
                ><button
                  class="danger"
                  :disabled="busy"
                  :aria-label="`彻底删除 ${entry.name}`"
                  @click="change(entry, true)"
                >
                  彻底删除
                </button>
              </div>
            </li>
          </ul>
        </div>
      </section>
    </dialog>
  </Teleport>
</template>

<style scoped>
.recycle-dialog {
  position: fixed;
  inset: 0;
  margin: 0;
  padding: 28px;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  border: 0;
  background: transparent;
  color: var(--app-text);
  font: inherit;
  box-sizing: border-box;
}
.recycle-dialog[open] {
  display: grid;
  place-items: center;
}
.recycle-dialog::backdrop {
  background: var(--app-backdrop);
  backdrop-filter: blur(3px);
}
.recycle-card {
  width: min(760px, 100%);
  max-height: calc(100dvh - 56px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: var(--app-surface);
  box-shadow: 0 24px 90px var(--app-shadow);
  overflow: hidden;
}
header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
  padding: 20px 24px;
  border-bottom: 1px solid var(--app-border);
}
h2 {
  margin: 0;
  font-size: 18px;
}
header p {
  margin: 8px 0 0;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.6;
}
.recycle-content {
  padding: 8px 24px;
  min-height: 240px;
  overflow: auto;
}
ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
li {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 18px 0;
  border-bottom: 1px solid var(--app-border);
}
li:last-child {
  border-bottom: 0;
}
li > svg {
  color: var(--app-muted);
  flex-shrink: 0;
}
.recycle-details {
  min-width: 0;
  flex: 1;
}
strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  font-size: 14px;
}
small {
  display: block;
  color: var(--app-muted);
  font-size: 11px;
  margin-top: 6px;
  line-height: 1.6;
}
.recycle-actions {
  display: flex;
  gap: 8px;
}
button {
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  color: var(--app-text);
  background: transparent;
  border: 1px solid var(--app-border);
  border-radius: 7px;
  padding: 7px 10px;
}
button:hover {
  background: var(--app-hover);
}
button:focus-visible {
  outline: 2px solid var(--app-focus);
  outline-offset: 2px;
}
button:disabled {
  opacity: 0.5;
  cursor: wait;
}
button.danger {
  color: var(--app-danger);
}
.icon-button {
  border: 0;
  padding: 5px;
}
.recycle-error {
  color: var(--app-danger);
  padding: 12px 0;
  font-size: 13px;
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.recycle-empty {
  color: var(--app-muted);
  text-align: center;
  margin: 60px 0;
  font-size: 13px;
}
@media (max-width: 600px) {
  .recycle-dialog {
    padding: 12px;
  }
  .recycle-card {
    max-height: calc(100dvh - 24px);
  }
  header {
    padding: 18px;
  }
  .recycle-content {
    padding: 0 18px;
  }
  li {
    flex-wrap: wrap;
  }
  .recycle-details {
    flex-basis: calc(100% - 40px);
  }
  .recycle-actions {
    margin-left: 32px;
  }
}
</style>
