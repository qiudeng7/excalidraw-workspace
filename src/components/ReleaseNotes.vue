<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { currentRelease, releases, type ReleaseNote } from "~/data/releases";

defineProps<{ history?: boolean }>();
const emit = defineEmits<{ shown: [] }>();
const content = ref<HTMLElement>();
let frame = 0;
let emitted = false;

function schedule() {
  cancelAnimationFrame(frame);
  if (emitted || document.visibilityState !== "visible") return;
  // Two frames let the modal and its content paint before advancing progress.
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      if (
        document.visibilityState === "visible" &&
        content.value?.checkVisibility()
      ) {
        emitted = true;
        emit("shown");
      }
    });
  });
}

const metadata = (release: ReleaseNote) =>
  `版本 ${release.version} · ${release.date}`;

onMounted(() => {
  schedule();
  document.addEventListener("visibilitychange", schedule);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  document.removeEventListener("visibilitychange", schedule);
});
</script>

<template>
  <div ref="content" class="release-notes">
    <article aria-label="当前版本更新">
      <p class="release-meta">
        {{ metadata(currentRelease) }} <span>当前版本</span>
      </p>
      <h4>{{ currentRelease.title }}</h4>
      <p>{{ currentRelease.summary }}</p>
      <ul>
        <li v-for="change in currentRelease.changes" :key="change">
          {{ change }}
        </li>
      </ul>
      <div v-if="currentRelease.actions.length" class="release-actions">
        <strong>需要你操作</strong>
        <ul>
          <li v-for="action in currentRelease.actions" :key="action">
            {{ action }}
          </li>
        </ul>
      </div>
      <p v-else class="release-meta">本次更新无需额外操作。</p>
    </article>
    <template v-if="history">
      <h4 class="release-history">历史更新</h4>
      <details v-for="release in releases.slice(1)" :key="release.id">
        <summary>{{ release.date }} · {{ release.title }}</summary>
        <p class="release-meta">{{ metadata(release) }}</p>
        <p>{{ release.summary }}</p>
        <ul>
          <li v-for="change in release.changes" :key="change">{{ change }}</li>
        </ul>
        <div v-if="release.actions.length" class="release-actions">
          <strong>当时的操作说明</strong>
          <ul>
            <li v-for="action in release.actions" :key="action">
              {{ action }}
            </li>
          </ul>
        </div>
      </details>
      <p v-if="releases.length === 1" class="release-meta">
        暂时没有更早的更新记录。
      </p>
    </template>
  </div>
</template>

<style scoped>
.release-notes {
  line-height: 1.7;
  overflow-wrap: anywhere;
}
h4 {
  margin: 12px 0;
  font-size: 19px;
}
p {
  margin: 12px 0;
}
ul {
  margin: 16px 0;
  padding-left: 22px;
}
li + li {
  margin-top: 10px;
}
.release-meta {
  color: var(--app-muted);
  font-size: 12px;
}
.release-meta span {
  margin-left: 8px;
  color: var(--app-success);
}
.release-actions {
  border: 1px solid var(--app-warning-border);
  background: var(--app-warning-bg);
  padding: 12px 16px;
  border-radius: 8px;
}
.release-history {
  padding-top: 20px;
  border-top: 1px solid var(--app-border);
}
details {
  margin-top: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--app-border);
}
summary {
  cursor: pointer;
}
</style>
