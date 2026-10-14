<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "~/lib/api";
import { confirmDialog } from "~/lib/dialogs";
import type {
  Member,
  ShareLink,
  PublishedVersion,
} from "#shared/collaboration/types";

const props = defineProps<{
  canvasId: string;
  userId: string;
  beforePublish: () => Promise<void>;
}>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const members = ref<Member[]>([]);
const links = ref<Omit<ShareLink, "secretHash">[]>([]);
const versions = ref<Omit<PublishedVersion, "scene">[]>([]);
const role = ref<"viewer" | "editor">("viewer");
const mode = ref<"live" | "latest" | "fixed">("latest");
const snapshotId = ref("");
const email = ref("");
const requireLogin = ref(true);
const expiry = ref("7");
const label = ref("");
const createdLink = ref("");
const error = ref("");
const busy = ref(false);
const section = ref<"members" | "links" | "versions">("members");
const linkInput = ref<HTMLInputElement>();
const copyFeedback = ref("");
const sections = [
  { id: "members", label: "邀请成员", icon: "users" },
  { id: "links", label: "分享链接", icon: "link" },
  { id: "versions", label: "固定版本", icon: "history" },
] as const;

function accessLabel(access: { role: string; viewMode: Member["viewMode"] }) {
  if (access.role === "editor") return "可编辑";

  return { live: "实时查看", latest: "最新版查看", fixed: "固定版本查看" }[
    access.viewMode
  ];
}

function versionLabel(id?: string) {
  return versions.value.find((version) => version.id === id)?.label ?? "";
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(createdLink.value);
    copyFeedback.value = "链接已复制";
  } catch (cause) {
    console.warn(
      "Share link clipboard access failed; selecting for manual copy",
      cause,
    );
    linkInput.value?.focus();
    linkInput.value?.select();
    copyFeedback.value = "无法自动复制，请复制已选中的链接";
  }
}

let publishId = "";

function request<T>(
  path: string,
  payload?: unknown,
  method = payload === undefined ? "GET" : "POST",
) {
  return api<T>(
    `/api/canvases/${encodeURIComponent(props.canvasId)}/collaboration/${path}`,
    {
      method,
      headers: { "X-Account-Owner": props.userId },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    },
  );
}

async function load() {
  const data = await request<{
    members: Member[];
    links: Omit<ShareLink, "secretHash">[];
    versions: Omit<PublishedVersion, "scene">[];
  }>("manage");

  members.value = data.members;
  links.value = data.links;
  versions.value = data.versions;
  if (!snapshotId.value) snapshotId.value = versions.value[0]?.id ?? "";
}

async function run(action: () => Promise<void>, refresh = true) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
    if (refresh) await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "操作失败";
  } finally {
    busy.value = false;
  }
}

function grant() {
  return {
    role: role.value,
    viewMode: role.value === "editor" ? "live" : mode.value,
    ...(mode.value === "fixed" && role.value === "viewer"
      ? { snapshotId: snapshotId.value }
      : {}),
  };
}

async function invite() {
  await request("members", { ...grant(), email: email.value });
  email.value = "";
}

async function createLink() {
  const data = await request<{ path: string }>("links", {
    ...grant(),
    requireLogin: requireLogin.value,
    expiresAt:
      expiry.value === "0"
        ? null
        : Date.now() + Number(expiry.value) * 86400000,
  });

  createdLink.value = new URL(data.path, location.origin).href;
  copyFeedback.value = "";
}

async function publish() {
  await props.beforePublish();
  publishId ||= crypto.randomUUID();
  const data = await request<{ id: string }>("versions", {
    id: publishId,
    label: label.value || new Date().toLocaleString(),
  });

  snapshotId.value = data.id;
  publishId = "";
  label.value = "";
}

async function removeVersion(id: string) {
  if (
    await confirmDialog({
      title: "删除固定版本",
      message: "引用此版本的成员授权和分享链接将失效，确定删除？",
      confirmLabel: "删除",
      danger: true,
    })
  )
    await request("versions", { id }, "DELETE");
}

function close() {
  if (!busy.value) {
    dialog.value?.close();
    emit("close");
  }
}

onMounted(() => {
  dialog.value?.showModal();
  void run(load, false);
});
onBeforeUnmount(() => dialog.value?.close());
</script>

<template>
  <dialog
    ref="dialog"
    class="share-dialog"
    aria-labelledby="share-title"
    @cancel.prevent="close"
    @click.self="close"
  >
    <section class="share-card" @click.stop @keydown.stop>
      <header class="share-heading">
        <div>
          <h2 id="share-title">分享画布</h2>
          <p>邀请他人协作，或分享只读内容。</p>
        </div>
        <button
          class="icon-button"
          type="button"
          :disabled="busy"
          aria-label="关闭分享"
          @click="close"
        >
          <QuietIcon name="close" />
        </button>
      </header>
      <nav class="share-sections" aria-label="分享管理">
        <button
          v-for="item in sections"
          :key="item.id"
          type="button"
          :aria-pressed="section === item.id"
          :disabled="busy"
          @click="section = item.id"
        >
          <QuietIcon :name="item.icon" :size="16" />{{ item.label }}
        </button>
      </nav>
      <div class="share-body" :aria-busy="busy">
        <div v-if="section !== 'versions'" class="grant-card">
          <div class="grant-fields">
            <label
              >权限<select v-model="role" aria-label="权限" :disabled="busy">
                <option value="viewer">查看者</option>
                <option value="editor">编辑者</option>
              </select></label
            >
            <label v-if="role === 'viewer'"
              >查看方式<select
                v-model="mode"
                aria-label="查看方式"
                :disabled="busy"
              >
                <option value="latest">最新版查看</option>
                <option value="live">实时查看</option>
                <option value="fixed">固定版本查看</option>
              </select></label
            >
          </div>
          <p class="hint">
            {{
              role === "editor"
                ? "可实时协作；同一段文字建议由一人编辑。"
                : mode === "latest"
                  ? "打开或手动刷新时读取最新内容，打开后不自动跟随。"
                  : mode === "live"
                    ? "实时跟随画布修改，始终只读。"
                    : "始终显示选定的版本，不受后续修改影响。"
            }}
          </p>
          <label
            v-if="role === 'viewer' && mode === 'fixed'"
            class="version-picker"
            >固定版本<select
              v-model="snapshotId"
              aria-label="固定版本"
              :disabled="busy"
            >
              <option disabled value="">请先发布版本</option>
              <option
                v-for="version in versions"
                :key="version.id"
                :value="version.id"
              >
                {{ version.label }}
              </option>
            </select></label
          >
          <button
            v-if="role === 'viewer' && mode === 'fixed' && !versions.length"
            class="text-button"
            type="button"
            :disabled="busy"
            @click="section = 'versions'"
          >
            先发布一个固定版本 <QuietIcon name="arrow" :size="14" />
          </button>
        </div>

        <template v-if="section === 'members'">
          <form class="inline-form" @submit.prevent="run(invite)">
            <label class="grow"
              >账号邮箱<input
                v-model="email"
                type="email"
                required
                placeholder="输入对方的注册邮箱"
                aria-label="邀请账号邮箱"
                :disabled="busy"
            /></label>
            <button
              class="primary-button"
              :disabled="
                busy || (role === 'viewer' && mode === 'fixed' && !snapshotId)
              "
            >
              邀请 / 更新权限
            </button>
          </form>
          <div class="list-heading">
            <h3>已邀请的成员</h3>
            <span>{{ members.length }}</span>
          </div>
          <ul v-if="members.length" class="resource-list">
            <li v-for="member in members" :key="member.userId">
              <span class="resource-icon avatar">{{
                member.name.slice(0, 1)
              }}</span>
              <div class="resource-info">
                <strong>{{ member.name }}</strong
                ><span
                  >{{ accessLabel(member)
                  }}<template v-if="member.viewMode === 'fixed'">
                    · {{ versionLabel(member.snapshotId) }}</template
                  ></span
                >
              </div>
              <button
                class="text-button destructive"
                :disabled="busy"
                :aria-label="`移除成员 ${member.name}`"
                @click="
                  run(async () => {
                    await request(
                      'members',
                      { userId: member.userId },
                      'DELETE',
                    );
                  })
                "
              >
                移除
              </button>
            </li>
          </ul>
          <p v-else class="empty-state">
            <QuietIcon name="users" :size="22" />{{
              busy ? "正在加载成员…" : "还没有邀请成员"
            }}<span v-if="!busy"
              >邀请后，对方可从「与我共享」打开这张画布。</span
            >
          </p>
        </template>

        <template v-else-if="section === 'links'">
          <div class="link-options">
            <label class="checkbox-label"
              ><input
                v-model="requireLogin"
                type="checkbox"
                :disabled="busy"
              />要求登录</label
            >
            <label class="expiry-label"
              >有效期<select v-model="expiry" :disabled="busy">
                <option value="1">1 天</option>
                <option value="7">7 天</option>
                <option value="30">30 天</option>
                <option value="0">长期有效</option>
              </select></label
            >
            <button
              class="primary-button"
              :disabled="
                busy || (role === 'viewer' && mode === 'fixed' && !snapshotId)
              "
              @click="run(createLink)"
            >
              生成链接
            </button>
          </div>
          <p v-if="!requireLogin && role === 'editor'" class="warning">
            任何持有链接的人都可以修改画布。
          </p>
          <div v-if="createdLink" class="created-link">
            <label for="new-share-link">新链接已生成</label>
            <div class="copy-row">
              <input
                id="new-share-link"
                ref="linkInput"
                :value="createdLink"
                readonly
                aria-label="新分享链接"
                @focus="($event.target as HTMLInputElement).select()"
              /><button type="button" @click="copyLink">
                <QuietIcon
                  :name="copyFeedback === '链接已复制' ? 'check' : 'copy'"
                  :size="15"
                />{{ copyFeedback === "链接已复制" ? "已复制" : "复制链接" }}
              </button>
            </div>
            <p class="hint" role="status">
              {{
                copyFeedback || "请保存此链接，关闭面板后无法再次查看完整地址。"
              }}
            </p>
          </div>
          <div class="list-heading">
            <h3>已生成的链接</h3>
            <span>{{ links.length }}</span>
          </div>
          <ul v-if="links.length" class="resource-list">
            <li v-for="link in links" :key="link.id">
              <span class="resource-icon"
                ><QuietIcon name="link" :size="17"
              /></span>
              <div class="resource-info">
                <strong
                  >{{ accessLabel(link)
                  }}<span class="badge">{{
                    link.requireLogin ? "需登录" : "访客可访问"
                  }}</span></strong
                ><span
                  >{{
                    link.expiresAt
                      ? `${new Date(link.expiresAt).toLocaleDateString()} 到期`
                      : "长期有效"
                  }}<template v-if="link.viewMode === 'fixed'">
                    · {{ versionLabel(link.snapshotId) }}</template
                  ></span
                >
              </div>
              <button
                class="text-button destructive"
                :disabled="busy"
                aria-label="撤销分享链接"
                @click="
                  run(async () => {
                    await request('links', { id: link.id }, 'DELETE');
                  })
                "
              >
                撤销
              </button>
            </li>
          </ul>
          <p v-else class="empty-state">
            <QuietIcon name="link" :size="22" />还没有分享链接<span
              >生成链接后，即可复制并发送给他人。</span
            >
          </p>
        </template>

        <template v-else>
          <p class="section-description">
            保存此刻的画布，用于固定版本分享。后续修改不会影响已发布版本。
          </p>
          <form class="inline-form" @submit.prevent="run(publish)">
            <label class="grow"
              >版本名称<input
                v-model="label"
                maxlength="100"
                placeholder="例如：方案定稿（可选）"
                aria-label="固定版本名称"
                :disabled="busy"
            /></label>
            <button class="primary-button" :disabled="busy">
              发布固定版本
            </button>
          </form>
          <div class="list-heading">
            <h3>已发布的版本</h3>
            <span>{{ versions.length }}</span>
          </div>
          <ul v-if="versions.length" class="resource-list">
            <li v-for="version in versions" :key="version.id">
              <span class="resource-icon"
                ><QuietIcon name="history" :size="17"
              /></span>
              <div class="resource-info">
                <strong>{{ version.label }}</strong
                ><span>{{ new Date(version.createdAt).toLocaleString() }}</span>
              </div>
              <button
                class="text-button destructive"
                :disabled="busy"
                :aria-label="`删除版本 ${version.label}`"
                @click="run(() => removeVersion(version.id))"
              >
                删除
              </button>
            </li>
          </ul>
          <p v-else class="empty-state">
            <QuietIcon name="history" :size="22" />还没有固定版本<span
              >发布后，可在邀请成员或生成链接时选择此版本。</span
            >
          </p>
        </template>
        <p v-if="error" class="error-message" role="alert">{{ error }}</p>
      </div>
      <footer>
        <QuietIcon name="lock" :size="13" /><span
          >仅授权当前画布，随时可撤销。</span
        ><span v-if="busy" role="status">处理中…</span>
      </footer>
    </section>
  </dialog>
</template>

<style scoped>
.share-dialog {
  box-sizing: border-box;
  padding: 0;
  width: min(560px, calc(100vw - 32px));
  max-height: min(760px, calc(100dvh - 40px));
  color: var(--app-text);
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: 14px;
  box-shadow: 0 20px 70px var(--app-shadow);
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}
.share-dialog::backdrop {
  background: var(--app-backdrop);
}
.share-card {
  padding: 24px 24px 0;
}
.share-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 22px;
}
h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.share-heading p {
  margin: 7px 0 0;
  color: var(--app-muted);
  font-size: 12px;
}
.share-sections {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: 8px;
  background: var(--app-hover);
}
.share-sections button {
  flex: 1;
  justify-content: center;
  padding: 9px 4px;
  border: 0;
  background: transparent;
  color: var(--app-muted);
}
.share-sections button[aria-pressed="true"] {
  color: var(--app-text);
  background: var(--app-surface);
  box-shadow: 0 1px 4px var(--app-shadow);
}
.share-body {
  padding: 20px 0;
  min-height: 292px;
}
.grant-card {
  padding: 14px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  margin-bottom: 18px;
}
.grant-fields {
  display: flex;
  gap: 12px;
}
.grant-fields label {
  flex: 1;
}
label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  color: var(--app-muted);
  font-size: 12px;
}
input,
select,
button {
  box-sizing: border-box;
  font: inherit;
  font-size: 12px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  color: var(--app-text);
  background: var(--app-surface);
}
input,
select {
  min-width: 0;
  min-height: 36px;
  padding: 8px 10px;
}
input::placeholder {
  color: var(--app-subtle);
}
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 12px;
  cursor: pointer;
  white-space: nowrap;
}
button:hover {
  background: var(--app-hover);
}
button:disabled {
  cursor: default;
  opacity: 0.5;
}
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--app-focus);
  outline-offset: 2px;
}
button.primary-button {
  background: var(--app-accent);
  color: var(--app-on-accent);
  border-color: var(--app-accent);
}
button.primary-button:hover {
  background: var(--app-accent-hover);
}
button.icon-button {
  padding: 6px;
  border: 0;
  color: var(--app-subtle);
}
button.text-button {
  padding: 6px 0;
  border: 0;
  background: transparent;
  color: var(--app-muted);
}
button.text-button:hover {
  color: var(--app-text);
}
button.destructive:hover {
  color: var(--app-danger);
}
.hint,
.section-description {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.7;
  margin: 10px 0 0;
}
.section-description {
  margin: 0 0 18px;
}
.version-picker {
  margin-top: 12px;
}
.inline-form {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.list-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 24px 0 8px;
  font-size: 11px;
  color: var(--app-subtle);
}
h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--app-muted);
}
.resource-list {
  padding: 0;
  margin: 0;
  list-style: none;
}
.resource-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid var(--app-border);
}
.resource-list li:last-child {
  border-bottom: 0;
}
.resource-icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  color: var(--app-muted);
  background: var(--app-hover);
  border-radius: 8px;
}
.avatar {
  border-radius: 50%;
  font-size: 13px;
}
.resource-info {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 5px;
}
.resource-info strong {
  color: var(--app-text);
  font-size: 12px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.resource-info > span {
  color: var(--app-subtle);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 400;
  color: var(--app-muted);
  border: 1px solid var(--app-border);
  border-radius: 4px;
  padding: 2px 5px;
  margin-left: 8px;
}
.empty-state {
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: 9px;
  padding: 20px 10px 6px;
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
  text-align: center;
  line-height: 1.6;
}
.empty-state > svg {
  color: var(--app-subtle);
}
.empty-state span {
  font-size: 11px;
  color: var(--app-subtle);
}
.link-options {
  display: flex;
  align-items: center;
  gap: 14px;
}
.checkbox-label,
.expiry-label {
  flex-direction: row;
  align-items: center;
  white-space: nowrap;
}
.checkbox-label input {
  min-height: 0;
  accent-color: var(--app-accent);
  width: 14px;
  height: 14px;
  margin: 0;
}
.link-options > button {
  margin-left: auto;
}
.created-link {
  margin-top: 18px;
  padding: 12px;
  background: var(--app-selected);
  border: 1px solid var(--app-border);
  border-radius: 8px;
}
.copy-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.copy-row input {
  flex: 1;
  width: 0;
  font-size: 11px;
}
.warning,
.error-message {
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-danger);
  margin: 12px 0 0;
}
footer {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 -24px;
  padding: 13px 24px;
  border-top: 1px solid var(--app-border);
  color: var(--app-subtle);
  font-size: 11px;
}
footer span:last-child:not(:first-of-type) {
  margin-left: auto;
}
@media (max-width: 480px) {
  .share-dialog {
    width: calc(100vw - 24px);
    max-height: calc(100dvh - 24px);
  }
  .share-card {
    padding: 20px 16px 0;
  }
  .share-sections button {
    font-size: 11px;
    gap: 5px;
  }
  .inline-form {
    flex-wrap: wrap;
  }
  .inline-form .grow {
    flex-basis: 100%;
  }
  .inline-form > button {
    width: 100%;
  }
  .link-options {
    flex-wrap: wrap;
    gap: 12px;
  }
  .link-options > button {
    flex-basis: 100%;
  }
  footer {
    margin: 0 -16px;
    padding: 13px 16px;
  }
}
</style>
