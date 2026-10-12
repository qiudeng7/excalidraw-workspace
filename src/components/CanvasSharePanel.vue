<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../lib/api";
import { confirmDialog } from "../lib/dialogs";
import type {
  Member,
  ShareLink,
  PublishedVersion,
} from "../../shared/collaboration/types";

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

async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
    await load();
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
  void run(load);
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
      <header>
        <h2 id="share-title">分享画布</h2>
        <button
          type="button"
          :disabled="busy"
          aria-label="关闭分享"
          @click="close"
        >
          关闭
        </button>
      </header>
      <p>
        权限仅适用于这张画布。文本按元素合并，同时编辑同一段文字时会采用其中一个版本。
      </p>
      <div class="grant-fields">
        <label
          >权限<select v-model="role" aria-label="权限">
            <option value="viewer">查看者</option>
            <option value="editor">编辑者</option>
          </select></label
        >
        <label v-if="role === 'viewer'"
          >查看方式<select v-model="mode" aria-label="查看方式">
            <option value="latest">最新版查看</option>
            <option value="live">实时查看</option>
            <option value="fixed">固定版本查看</option>
          </select></label
        >
        <label v-if="role === 'viewer' && mode === 'fixed'"
          >固定版本<select v-model="snapshotId" aria-label="固定版本">
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
      </div>
      <p v-if="role === 'viewer'">
        {{
          mode === "latest"
            ? "打开或手动刷新时读取最新已保存内容，打开后保持不变。"
            : mode === "live"
              ? "持续跟随画布修改，始终只读。"
              : "始终显示指定的固定版本，重新打开也保持不变。"
        }}
      </p>
      <h3>邀请已有账号</h3>
      <form class="inline-form" @submit.prevent="run(invite)">
        <input
          v-model="email"
          type="email"
          required
          placeholder="账号邮箱"
          aria-label="邀请账号邮箱"
        /><button
          :disabled="
            busy || (role === 'viewer' && mode === 'fixed' && !snapshotId)
          "
        >
          邀请 / 更新权限
        </button>
      </form>
      <ul>
        <li v-for="member in members" :key="member.userId">
          <span
            >{{ member.name }} ·
            {{
              member.role === "editor"
                ? "编辑者"
                : {
                    live: "实时查看",
                    fixed: "固定版本查看",
                    latest: "最新版查看",
                  }[member.viewMode]
            }}</span
          ><button
            :disabled="busy"
            @click="
              run(async () => {
                await request('members', { userId: member.userId }, 'DELETE');
              })
            "
          >
            移除
          </button>
        </li>
      </ul>
      <h3>分享链接</h3>
      <div class="grant-fields">
        <label><input v-model="requireLogin" type="checkbox" />要求登录</label
        ><label
          >有效期<select v-model="expiry">
            <option value="1">1 天</option>
            <option value="7">7 天</option>
            <option value="30">30 天</option>
            <option value="0">长期有效</option>
          </select></label
        ><button
          :disabled="
            busy || (role === 'viewer' && mode === 'fixed' && !snapshotId)
          "
          @click="run(createLink)"
        >
          生成链接
        </button>
      </div>
      <p v-if="!requireLogin && role === 'editor'">
        任何持有链接的人都可以修改画布。
      </p>
      <label v-if="createdLink" class="created-link"
        >请复制并妥善保管链接<input
          :value="createdLink"
          readonly
          aria-label="新分享链接"
          @focus="($event.target as HTMLInputElement).select()"
      /></label>
      <ul>
        <li v-for="link in links" :key="link.id">
          <span
            >{{
              link.role === "editor"
                ? "编辑"
                : {
                    live: "实时查看",
                    fixed: "固定版本查看",
                    latest: "最新版查看",
                  }[link.viewMode]
            }}
            · {{ link.requireLogin ? "需登录" : "访客可访问" }} ·
            {{
              link.expiresAt
                ? new Date(link.expiresAt).toLocaleDateString()
                : "长期"
            }}</span
          ><button
            :disabled="busy"
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
      <h3>固定版本</h3>
      <form class="inline-form" @submit.prevent="run(publish)">
        <input
          v-model="label"
          maxlength="100"
          placeholder="版本名称（可选）"
          aria-label="固定版本名称"
        /><button :disabled="busy">发布当前已保存内容</button>
      </form>
      <ul>
        <li v-for="version in versions" :key="version.id">
          <span
            >{{ version.label }} ·
            {{ new Date(version.createdAt).toLocaleString() }}</span
          ><button
            :disabled="busy"
            @click="run(() => removeVersion(version.id))"
          >
            删除
          </button>
        </li>
      </ul>
      <p v-if="error" role="alert">{{ error }}</p>
    </section>
  </dialog>
</template>

<style scoped>
.share-dialog {
  padding: 0;
  width: min(680px, calc(100vw - 32px));
  max-height: 85vh;
  color: var(--app-text);
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: 16px;
}
.share-dialog::backdrop {
  background: #0005;
}
.share-card {
  padding: 24px;
}
header,
li,
.grant-fields,
.inline-form {
  display: flex;
  align-items: center;
  gap: 12px;
}
header,
li {
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: 20px;
}
h3 {
  margin: 24px 0 12px;
  font-size: 15px;
}
p,
li {
  font-size: 13px;
  line-height: 1.6;
}
label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
ul {
  padding: 0;
  list-style: none;
}
li {
  padding: 8px 0;
  border-bottom: 1px solid var(--app-border);
}
.inline-form input,
.created-link input {
  flex: 1;
  min-width: 0;
}
input,
select,
button {
  font: inherit;
  padding: 7px 10px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  color: inherit;
  background: var(--app-bg);
}
.created-link {
  display: grid;
  margin-top: 16px;
}
@media (max-width: 600px) {
  .grant-fields,
  .inline-form {
    flex-wrap: wrap;
  }
}
</style>
