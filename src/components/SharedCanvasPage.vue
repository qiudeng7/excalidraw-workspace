<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { accountApi } from "~/lib/accountApi";
import { api, ApiError } from "~/lib/api";
import { closeCollaboration } from "~/lib/collaboration/session";
import { getTabScope } from "~/lib/persistence";
import {
  richTextRecoveryStorageKey,
  readRichTextRecovery,
  downloadRichTextRecovery,
} from "~/lib/richTextRecovery";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
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
const shareButton = ref<HTMLButtonElement>();
const deniedTextRecovery = ref<ExcalidrawElement>();
let deniedRecoveryKey = "";
const personalSettings = shallowRef<UserSettingsResource>();
const onlineCount = ref(0),
  onlineLabel = ref("");
let secret = "";
const scope = `public:${crypto.randomUUID()}`;

async function initialize() {
  error.value = "";
  login.value = false;
  deniedTextRecovery.value = undefined;
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
    } else {
      error.value = cause instanceof Error ? cause.message : "无法打开画布";
      // A revoked original URL can fail before mounting an editor. Only read the
      // previous capability's local recovery entry; never request its scene.
      try {
        const previousToken = props.share
          ? (sessionStorage.getItem(
              `canvas-share:${props.canvasId}:${user.value?.id ?? "guest"}`,
            ) ?? undefined)
          : undefined;

        if (!props.share || previousToken) {
          deniedRecoveryKey = await richTextRecoveryStorageKey(
            {
              canvasId: props.canvasId,
              userId: user.value?.id,
              token: previousToken,
            },
            await getTabScope(),
          );
          deniedTextRecovery.value = readRichTextRecovery(deniedRecoveryKey);
        }
      } catch (recoveryError) {
        console.warn("无法读取本地文字恢复副本", recoveryError);
      }
    }
  }
}

function clearDeniedRecovery() {
  try {
    localStorage.removeItem(deniedRecoveryKey);
    deniedTextRecovery.value = undefined;
  } catch (cause) {
    console.warn("无法清除本地文字恢复副本", cause);
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
        <div class="shared-identity">
          <NuxtLink
            to="/"
            class="home-link"
            aria-label="返回画布空间"
            title="返回画布空间"
            ><QuietIcon name="canvas" :size="18" /><span
              >画布空间</span
            ></NuxtLink
          ><span class="header-divider">/</span
          ><strong :title="canvasTitle">{{ canvasTitle || "共享画布" }}</strong
          ><span v-if="role === 'viewer'" class="access-badge"
            >{{
              mode === "fixed"
                ? "固定版本"
                : mode === "latest"
                  ? "最新版"
                  : "实时查看"
            }}
            · 只读</span
          >
        </div>
        <div class="shared-actions">
          <span v-if="mode === 'live'" class="presence" :title="onlineLabel"
            ><QuietIcon name="users" :size="14" />{{
              onlineCount
            }}
            个会话在线</span
          ><span class="sync-state" role="status">{{ status }}</span>
          <button v-if="mode === 'latest'" type="button" @click="refresh">
            <QuietIcon name="refresh" :size="14" />刷新最新版
          </button>
          <button
            v-if="role === 'owner' && user"
            type="button"
            ref="shareButton"
            @click="shareOpen = true"
          >
            <QuietIcon name="link" :size="14" />分享
          </button>
          <ThemeSwitcher />
        </div>
      </header>
      <div v-if="error" class="shared-error" role="alert">
        <QuietIcon name="lock" :size="22" /><strong>暂时无法打开画布</strong>
        <p>{{ error }}</p>
        <button type="button" @click="initialize">重试</button>
        <div v-if="deniedTextRecovery" class="local-recovery" role="status">
          <p>文字编辑已结束，本地富文本副本已保留。</p>
          <button
            type="button"
            @click="downloadRichTextRecovery(deniedTextRecovery)"
          >
            下载文字副本
          </button>
          <button type="button" @click="clearDeniedRecovery">忽略</button>
        </div>
      </div>
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
        :return-focus="shareButton"
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
  color: var(--app-text);
  background: var(--app-surface);
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}
.shared-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
  min-height: 50px;
  padding: 8px 18px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--app-border);
}
.shared-identity,
.shared-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.shared-identity {
  min-width: 0;
}
.shared-identity strong {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.home-link {
  display: flex;
  align-items: center;
  gap: 7px;
  text-decoration: none;
  color: var(--app-muted);
  font-size: 12px;
  white-space: nowrap;
}
.home-link:hover {
  color: var(--app-text);
}
.header-divider {
  color: var(--app-subtle);
  font-size: 12px;
}
.access-badge {
  flex-shrink: 0;
  color: var(--app-muted);
  font-size: 10px;
  padding: 4px 7px;
  border-radius: 5px;
  background: var(--app-hover);
}
.shared-actions {
  flex-shrink: 0;
}
.presence,
.sync-state {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--app-muted);
  font-size: 11px;
}
.shared-page button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font: inherit;
  font-size: 11px;
  border: 1px solid var(--app-border);
  background: var(--app-surface);
  color: var(--app-muted);
  border-radius: 6px;
  padding: 7px 9px;
  cursor: pointer;
}
.local-recovery {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--app-border);
}
.local-recovery button + button {
  margin-left: 8px;
}
.shared-page button:hover {
  background: var(--app-hover);
  color: var(--app-text);
}
.shared-page button:focus-visible,
.home-link:focus-visible {
  outline: 2px solid var(--app-focus);
  outline-offset: 2px;
}
.shared-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 24px;
  margin: auto;
  color: var(--app-muted);
  font-size: 13px;
  text-align: center;
}
.shared-error strong {
  color: var(--app-text);
  font-size: 15px;
  font-weight: 500;
}
.shared-error p {
  margin: 0;
  max-width: 400px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.shared-page :deep(.collaboration-editor) {
  flex: 1;
  min-height: 0;
}
@media (max-width: 760px) {
  .shared-header {
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 12px;
  }
  .shared-identity {
    flex: 1;
  }
  .home-link span {
    display: none;
  }
  .shared-actions {
    width: 100%;
    gap: 10px;
  }
  .shared-actions > :last-child {
    margin-left: auto;
  }
  .sync-state {
    min-width: 0;
    overflow-wrap: anywhere;
  }
}
</style>
