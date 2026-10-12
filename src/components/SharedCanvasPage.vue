<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { accountApi } from "~/lib/accountApi";
import { api, ApiError } from "~/lib/api";
import { closeCollaboration } from "~/lib/collaboration/session";
import type { Bootstrap, User } from "#shared/contracts";
import type { EditorHandle } from "~/lib/editor";
import {
  createUserSettingsResource,
  type UserSettingsResource,
} from "~/lib/userSettings";

const props = defineProps<{ canvasId: string; share?: boolean }>();
const user = ref<User | null>(null);
const token = ref<string>();
const ready = ref(false);
const role = ref("");
const mode = ref("");
const status = ref("正在校验版本…");
const canvasTitle = ref("");
const error = ref("");
const login = ref(false);
const bootstrap = ref<Bootstrap>();
const editor = ref<EditorHandle>();
const shareOpen = ref(false);
const personalSettings = shallowRef<UserSettingsResource>();
const onlineCount = ref(0),
  onlineLabel = ref("");
let secret = "";
const scope = `public:${crypto.randomUUID()}`;

async function initialize() {
  error.value = "";
  login.value = false;
  try {
    user.value = await accountApi.session();
    if (user.value && personalSettings.value?.userId !== user.value.id) {
      personalSettings.value?.dispose();
      personalSettings.value = createUserSettingsResource(user.value.id);
      void personalSettings.value.load();
    } else if (!user.value) {
      personalSettings.value?.dispose();
      personalSettings.value = undefined;
    }

    const key = `canvas-share:${props.canvasId}:${user.value?.id ?? "guest"}`;

    if (props.share) {
      secret ||= location.hash.slice(1);
      if (secret) {
        const exchanged = await api<{ token: string }>(
          `/api/canvases/${encodeURIComponent(props.canvasId)}/collaboration/exchange`,
          { method: "POST", body: JSON.stringify({ secret }) },
        );

        token.value = exchanged.token;
        sessionStorage.setItem(key, token.value);
        history.replaceState(null, "", location.pathname + location.search);
        secret = "";
      } else token.value = sessionStorage.getItem(key) ?? undefined;
      if (!token.value) throw new Error("请从原分享链接打开画布");
    } else if (!user.value)
      throw new ApiError(401, "LOGIN_REQUIRED", "请先登录");
    ready.value = true;
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) {
      login.value = true;
      bootstrap.value = await accountApi.bootstrap();
    } else
      error.value = cause instanceof Error ? cause.message : "无法打开画布";
  }
}

async function refresh() {
  try {
    await editor.value?.refresh?.();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "读取失败";
  }
}

onMounted(initialize);
onBeforeUnmount(() => {
  personalSettings.value?.dispose();
  closeCollaborationScope();
});

function closeCollaborationScope() {
  closeCollaboration(undefined, scope);
}

async function flushForShare() {
  await editor.value?.flush();
}
</script>

<template>
  <section class="shared-page">
    <AccountGate
      v-if="login && bootstrap"
      :bootstrap="bootstrap"
      @authenticated="initialize"
      @refresh="initialize"
    />
    <template v-else>
      <header class="shared-header">
        <NuxtLink to="/">画布空间</NuxtLink><strong>{{ canvasTitle }}</strong
        ><span v-if="mode === 'live'" :title="onlineLabel"
          >{{ onlineCount }} 人在线</span
        ><span role="status">{{ status }}</span>
        <button v-if="mode === 'latest'" type="button" @click="refresh">
          刷新最新版
        </button>
        <button
          v-if="role === 'owner' && user"
          type="button"
          @click="shareOpen = true"
        >
          分享
        </button>
        <ThemeSwitcher />
      </header>
      <p v-if="error" role="alert">
        {{ error }} <button type="button" @click="initialize">重试</button>
      </p>
      <ClientOnly
        ><CollaborationCanvas
          v-if="ready"
          ref="editor"
          :canvas-id="canvasId"
          :user-id="user?.id"
          :token="token"
          :scope="scope"
          :user-settings="personalSettings?.state.settings"
          @status="status = $event"
          @title="canvasTitle = $event"
          @participants="
            (count, label) => {
              onlineCount = count;
              onlineLabel = label;
            }
          "
          @access="
            (nextRole, nextMode) => {
              role = nextRole;
              mode = nextMode;
            }
          "
      /></ClientOnly>
      <CanvasSharePanel
        v-if="shareOpen && user"
        :canvas-id="canvasId"
        :user-id="user.id"
        :before-publish="flushForShare"
        @close="shareOpen = false"
      />
    </template>
  </section>
</template>

<style scoped>
.shared-page {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  overflow: hidden;
}
.shared-header {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
  min-height: 48px;
  padding: 0 16px;
  border-bottom: 1px solid var(--app-border);
}
.shared-header span {
  margin-left: auto;
  font-size: 13px;
  color: var(--app-muted);
}
.shared-page :deep(.collaboration-editor) {
  flex: 1;
  min-height: 0;
}
</style>
