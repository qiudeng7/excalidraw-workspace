<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import type { OidcProviderRecord, OidcProviderType } from "#shared/oidc";
import { oidcProviderPresets, oidcProviderTypes } from "#shared/oidc";
import QuietIcon from "./QuietIcon.vue";
import { confirmDialog } from "~/lib/dialogs";
import {
  oidcProvidersApi,
  type OidcProviderInput,
} from "~/lib/oidcProvidersApi";
import { assetUrl } from "~/lib/runtime";

const MAX_ICON_BYTES = 256 * 1024;
const ICON_TYPES = ["image/png", "image/svg+xml", "image/webp"];
const DEFAULT_SCOPES = "openid profile email";
const DEFAULT_TYPE: OidcProviderType = "microsoft";

const providers = ref<OidcProviderRecord[]>([]);
const loading = ref(true);
const error = ref("");
const busy = ref(false);
const dialog = ref<HTMLDialogElement>();
const callback = ref<HTMLInputElement>();
const iconInput = ref<HTMLInputElement>();
const editingId = ref<string | null>(null);
const pendingIcon = ref("");
const showSecret = ref(false);
const copied = ref(false);
const formError = ref("");

interface ProviderForm {
  id: string;
  type: OidcProviderType;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  enabled: boolean;
  autoRegister: boolean;
}

const form = reactive<ProviderForm>({
  id: "",
  type: DEFAULT_TYPE,
  name: "",
  issuer: "",
  clientId: "",
  clientSecret: "",
  scopes: DEFAULT_SCOPES,
  enabled: true,
  autoRegister: true,
});
let returnFocus: HTMLElement | null = null;

const isCustom = computed(() => form.type === "custom");
const editing = computed(() =>
  providers.value.find((provider) => provider.id === editingId.value),
);
const iconSrc = computed(() => {
  if (pendingIcon.value) return pendingIcon.value;

  return editing.value?.iconUrl ? assetUrl(editing.value.iconUrl) : "";
});
/** 服务端按 PUBLIC_ORIGIN 拼回调地址，这里用当前 origin 展示同一个值。 */
const callbackUrl = computed(() =>
  form.id && typeof location !== "undefined"
    ? `${location.origin}/api/auth/oidc/${form.id}/callback`
    : "",
);

function typeLabel(type: OidcProviderType) {
  return oidcProviderPresets[type].label;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    providers.value = await oidcProvidersApi.list();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法读取登录方式";
  } finally {
    loading.value = false;
  }
}

function open(provider?: OidcProviderRecord) {
  returnFocus = document.activeElement as HTMLElement | null;
  formError.value = "";
  pendingIcon.value = "";
  showSecret.value = false;
  copied.value = false;
  editingId.value = provider?.id ?? null;
  Object.assign(
    form,
    provider
      ? {
          id: provider.id,
          type: provider.type,
          name: provider.name,
          issuer: provider.issuer,
          clientId: provider.clientId,
          clientSecret: provider.clientSecret,
          scopes: provider.scopes,
          enabled: provider.enabled,
          autoRegister: provider.autoRegister,
        }
      : {
          id: crypto.randomUUID(),
          type: DEFAULT_TYPE,
          name: oidcProviderPresets[DEFAULT_TYPE].label,
          issuer: oidcProviderPresets[DEFAULT_TYPE].issuer,
          clientId: "",
          clientSecret: "",
          scopes: DEFAULT_SCOPES,
          enabled: true,
          autoRegister: true,
        },
  );
  dialog.value?.showModal();
}

function closeDialog() {
  dialog.value?.close();
  if (returnFocus?.isConnected) returnFocus.focus();
}

/** 预设类型带出名称与 issuer；已手改过同名同值的输入才跟着换。 */
function selectType(next: OidcProviderType) {
  const previous = oidcProviderPresets[form.type];
  const preset = oidcProviderPresets[next];

  form.type = next;
  if (form.name === previous.label) form.name = preset.label;
  if (form.issuer === previous.issuer) form.issuer = preset.issuer;
}

function onTypeChange(event: Event) {
  selectType((event.target as HTMLSelectElement).value as OidcProviderType);
}

function readFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("图标读取失败")),
    );
    reader.readAsDataURL(file);
  });
}

async function chooseIcon(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];

  input.value = "";
  if (!file) return;
  formError.value = "";
  if (!ICON_TYPES.includes(file.type)) {
    formError.value = "图标仅支持 png、svg、webp 图片";

    return;
  }

  if (file.size > MAX_ICON_BYTES) {
    formError.value = "图标不能超过 256 KB";

    return;
  }

  try {
    pendingIcon.value = await readFile(file);
  } catch (cause) {
    formError.value = cause instanceof Error ? cause.message : "图标读取失败";
  }
}

async function save() {
  if (busy.value) return;

  busy.value = true;
  formError.value = "";
  try {
    const input: OidcProviderInput = {
      id: form.id,
      type: form.type,
      name: form.name,
      issuer: form.issuer,
      clientId: form.clientId,
      clientSecret: form.clientSecret,
      scopes: form.scopes,
      enabled: form.enabled,
      autoRegister: form.autoRegister,
    };

    if (editingId.value) await oidcProvidersApi.update(editingId.value, input);
    else await oidcProvidersApi.create(input);
    // 图标单独上传：identity 已存在，失败时身份源仍可编辑重试。
    if (pendingIcon.value)
      await oidcProvidersApi.uploadIcon(form.id, pendingIcon.value);
    closeDialog();
    await load();
  } catch (cause) {
    formError.value =
      cause instanceof Error ? cause.message : "保存失败，请重试";
  } finally {
    busy.value = false;
  }
}

function replace(provider: OidcProviderRecord) {
  providers.value = providers.value.map((current) =>
    current.id === provider.id ? provider : current,
  );
}

async function toggleEnabled(provider: OidcProviderRecord, event: Event) {
  const input = event.target as HTMLInputElement;
  const enabled = input.checked;

  input.checked = provider.enabled;
  error.value = "";
  try {
    replace(await oidcProvidersApi.update(provider.id, { enabled }));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "启用状态修改失败";
  }
}

async function remove(provider: OidcProviderRecord) {
  const confirmed = await confirmDialog({
    title: "删除登录方式",
    message: `确定删除“${provider.name}”？已通过它登录的账户会保留，但不能再使用这个方式登录。`,
    confirmLabel: "删除",
    danger: true,
  });

  if (!confirmed) return;
  error.value = "";
  try {
    await oidcProvidersApi.remove(provider.id);
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "删除失败，请重试";
  }
}

async function copyCallback() {
  if (!callbackUrl.value) return;
  try {
    await navigator.clipboard.writeText(callbackUrl.value);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 2000);
  } catch (cause) {
    // 非安全上下文或权限被拒时退回手动选择。
    console.warn("无法写入剪贴板，改为手动复制", cause);
    callback.value?.select();
    formError.value = "无法自动复制，请按 Ctrl+C 复制选中的地址";
  }
}

onMounted(load);
</script>

<template>
  <div class="oidc-settings">
    <div class="oidc-heading">
      <span class="oidc-copy">
        <strong>登录方式 <span class="oidc-admin">ADMIN</span></strong>
        <small
          >已启用的身份源会出现在登录页。账户按实际 issuer 与 sub
          映射，删除身份源不会删除已有账户。</small
        >
      </span>
      <button
        type="button"
        class="oidc-create"
        :disabled="loading"
        @click="open()"
      >
        <QuietIcon name="plus" :size="14" />新建身份源
      </button>
    </div>
    <p v-if="error" class="oidc-error" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="oidc-empty">正在读取登录方式…</p>
    <p v-else-if="!providers.length" class="oidc-empty">
      还没有身份源。新建后，登录页会显示对应的登录按钮。
    </p>
    <div v-else class="oidc-table-wrap">
      <table class="oidc-table">
        <thead>
          <tr>
            <th scope="col">名称</th>
            <th scope="col">类型</th>
            <th scope="col">Issuer</th>
            <th scope="col">启用</th>
            <th scope="col"><span class="oidc-hidden">操作</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="provider in providers" :key="provider.id">
            <td>
              <span class="oidc-name">
                <img
                  v-if="provider.iconUrl"
                  :src="assetUrl(provider.iconUrl)"
                  alt=""
                  width="18"
                  height="18"
                />
                {{ provider.name }}
              </span>
            </td>
            <td>{{ typeLabel(provider.type) }}</td>
            <td class="oidc-issuer">{{ provider.issuer }}</td>
            <td>
              <label class="oidc-switch"
                ><input
                  type="checkbox"
                  :checked="provider.enabled"
                  :aria-label="`启用 ${provider.name}`"
                  @change="toggleEnabled(provider, $event)" /><span
                  aria-hidden="true"
              /></label>
            </td>
            <td class="oidc-row-actions">
              <button type="button" @click="open(provider)">编辑</button>
              <button type="button" class="danger" @click="remove(provider)">
                删除
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="oidc-dialog"
      aria-modal="true"
      aria-label="身份源"
      @cancel.prevent="closeDialog"
      @click.self="closeDialog"
    >
      <form class="oidc-card" @submit.prevent="save" @click.stop>
        <header class="oidc-card-heading">
          <h2>{{ editingId ? "编辑身份源" : "新建身份源" }}</h2>
          <button type="button" aria-label="关闭" @click="closeDialog">
            <QuietIcon name="close" :size="18" />
          </button>
        </header>
        <div class="oidc-fields">
          <div class="oidc-row">
            <label>
              <span>类型</span>
              <select
                :value="form.type"
                :disabled="!!editingId"
                @change="onTypeChange"
              >
                <option
                  v-for="type in oidcProviderTypes"
                  :key="type"
                  :value="type"
                >
                  {{ oidcProviderPresets[type].label }}
                </option>
              </select>
            </label>
            <label>
              <span>显示名称</span>
              <input v-model="form.name" maxlength="100" required />
            </label>
          </div>
          <label>
            <span>Issuer</span>
            <input
              v-model="form.issuer"
              type="url"
              spellcheck="false"
              placeholder="https://idp.example.com"
              required
            />
            <small v-if="form.type === 'microsoft'"
              >可保留 common 多租户端点；id_token 的实际租户 issuer
              会自动识别并用于账户映射。</small
            >
            <small v-else-if="form.type === 'gitlab'"
              >自建 GitLab 填实例根地址，例如 https://gitlab.example.com</small
            >
          </label>
          <div class="oidc-row">
            <label>
              <span>客户端 ID</span>
              <input v-model="form.clientId" spellcheck="false" required />
            </label>
            <label>
              <span>客户端密钥</span>
              <span class="oidc-secret">
                <input
                  v-model="form.clientSecret"
                  :type="showSecret ? 'text' : 'password'"
                  autocomplete="new-password"
                  spellcheck="false"
                  required
                />
                <button type="button" @click="showSecret = !showSecret">
                  {{ showSecret ? "隐藏" : "显示" }}
                </button>
              </span>
            </label>
          </div>
          <label>
            <span>Scope</span>
            <input v-model="form.scopes" spellcheck="false" />
            <small>空格分隔，必须包含 openid。</small>
          </label>
          <div v-if="isCustom" class="oidc-icon-field">
            <span class="oidc-icon-preview">
              <img v-if="iconSrc" :src="iconSrc" alt="" />
              <QuietIcon v-else name="canvas" :size="20" />
            </span>
            <span class="oidc-copy">
              <strong>图标（可选）</strong>
              <small>png、svg 或 webp，不超过 256 KB。</small>
              <input
                ref="iconInput"
                type="file"
                accept="image/png,image/svg+xml,image/webp"
                hidden
                @change="chooseIcon"
              />
              <button
                type="button"
                class="oidc-file"
                @click="iconInput?.click()"
              >
                {{ iconSrc ? "更换图片" : "选择图片" }}
              </button>
            </span>
          </div>
          <div class="oidc-toggles">
            <label><input v-model="form.enabled" type="checkbox" />启用</label>
            <label
              ><input
                v-model="form.autoRegister"
                type="checkbox"
              />首次登录自动创建账户</label
            >
          </div>
          <label class="oidc-callback">
            <span>回调地址</span>
            <span class="oidc-secret">
              <input ref="callback" :value="callbackUrl" readonly />
              <button type="button" @click="copyCallback">
                {{ copied ? "已复制" : "复制" }}
              </button>
            </span>
            <small>在该身份源中以这个地址登记重定向 URI。</small>
          </label>
          <p v-if="formError" class="oidc-error" role="alert">
            {{ formError }}
          </p>
        </div>
        <footer class="oidc-card-footer">
          <button type="button" @click="closeDialog">取消</button>
          <button class="primary" :disabled="busy">
            {{ busy ? "保存中…" : "保存" }}
          </button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.oidc-settings {
  padding: 17px 0;
  border-bottom: 1px solid var(--app-border);
}
.oidc-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}
.oidc-copy {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}
.oidc-copy strong {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}
.oidc-copy small {
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.8;
}
.oidc-admin {
  margin-left: 6px;
  color: var(--app-subtle);
  font-size: 8px;
  letter-spacing: 0.08em;
}
.oidc-create {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 7px 10px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface);
  color: var(--app-text);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.oidc-create:hover {
  background: var(--app-hover);
}
.oidc-empty {
  margin: 14px 0 2px;
  color: var(--app-subtle);
  font-size: 12px;
}
.oidc-table-wrap {
  margin-top: 14px;
  overflow-x: auto;
}
.oidc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.oidc-table th {
  padding: 0 10px 8px 0;
  color: var(--app-subtle);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-align: left;
  white-space: nowrap;
}
.oidc-table td {
  padding: 9px 10px 9px 0;
  border-top: 1px solid var(--app-border);
  vertical-align: middle;
}
.oidc-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}
.oidc-name img {
  width: 18px;
  height: 18px;
  object-fit: contain;
}
.oidc-issuer {
  max-width: 230px;
  color: var(--app-muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oidc-row-actions {
  white-space: nowrap;
  text-align: right;
}
.oidc-row-actions button {
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: none;
  color: var(--app-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.oidc-row-actions button:hover {
  border-color: var(--app-border);
  color: var(--app-text);
}
.oidc-row-actions button.danger:hover {
  border-color: var(--app-danger-border);
  color: var(--app-danger);
}
.oidc-switch {
  position: relative;
  display: inline-flex;
}
.oidc-switch input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  clip-path: inset(50%);
}
.oidc-switch span {
  position: relative;
  width: 34px;
  height: 20px;
  border-radius: 12px;
  background: var(--app-switch);
  cursor: pointer;
}
.oidc-switch span::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--app-on-accent);
  box-shadow: 0 1px 3px #0002;
  transition: transform 0.15s;
}
.oidc-switch input:checked + span {
  background: var(--app-switch-active);
}
.oidc-switch input:checked + span::after {
  transform: translateX(14px);
}
.oidc-switch input:focus-visible + span {
  outline: 2px solid var(--app-focus);
  outline-offset: 3px;
}
.oidc-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.oidc-error {
  color: var(--app-danger);
  font-size: 12px;
  line-height: 1.7;
}
.oidc-dialog {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  box-sizing: border-box;
  margin: 0;
  padding: 24px;
  border: 0;
  background: transparent;
  color: var(--app-text);
  font: inherit;
}
.oidc-dialog[open] {
  display: grid;
  place-items: center;
}
.oidc-dialog::backdrop {
  background: var(--app-backdrop);
  backdrop-filter: blur(3px);
}
.oidc-card {
  display: flex;
  flex-direction: column;
  width: min(520px, 100%);
  max-height: min(720px, calc(100dvh - 48px));
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-surface);
  box-shadow: 0 24px 90px var(--app-shadow);
}
.oidc-card-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 22px;
  border-bottom: 1px solid var(--app-border);
}
.oidc-card-heading h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.oidc-card-heading button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
}
.oidc-card-heading button:hover {
  background: var(--app-hover);
}
.oidc-fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 22px;
  overflow: auto;
}
.oidc-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.oidc-fields label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 12px;
  font-weight: 500;
}
.oidc-fields label > span:first-child {
  color: var(--app-text);
}
.oidc-fields input:not([type="checkbox"]),
.oidc-fields select {
  font: inherit;
  font-size: 13px;
  box-sizing: border-box;
  width: 100%;
  height: 38px;
  padding: 0 11px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  outline: none;
  background: var(--app-surface);
  color: var(--app-text);
}
.oidc-fields input:focus,
.oidc-fields select:focus {
  border-color: var(--app-focus);
  box-shadow: 0 0 0 3px var(--app-focus-ring);
}
.oidc-fields input[readonly] {
  color: var(--app-muted);
}
.oidc-fields select:disabled {
  opacity: 0.6;
}
.oidc-fields small {
  color: var(--app-muted);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.7;
}
.oidc-secret {
  display: flex;
  gap: 8px;
}
.oidc-secret input {
  min-width: 0;
  flex: 1;
}
.oidc-secret button {
  flex: none;
  padding: 0 10px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface);
  color: var(--app-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.oidc-secret button:hover {
  background: var(--app-hover);
  color: var(--app-text);
}
.oidc-icon-field {
  display: flex;
  align-items: center;
  gap: 14px;
}
.oidc-icon-preview {
  display: grid;
  place-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  color: var(--app-subtle);
}
.oidc-icon-preview img {
  width: 26px;
  height: 26px;
  object-fit: contain;
}
.oidc-file {
  align-self: flex-start;
  padding: 6px 10px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface);
  color: var(--app-text);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.oidc-file:hover {
  background: var(--app-hover);
}
.oidc-toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
}
.oidc-toggles label {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  font-weight: 400;
  cursor: pointer;
}
.oidc-card-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 22px;
  border-top: 1px solid var(--app-border);
}
.oidc-card-footer button {
  padding: 8px 14px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface);
  color: var(--app-text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.oidc-card-footer button:hover {
  background: var(--app-hover);
}
.oidc-card-footer button.primary {
  border-color: transparent;
  background: var(--app-accent);
  color: var(--app-on-accent);
}
.oidc-card-footer button.primary:hover {
  background: var(--app-accent-hover);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
@media (max-width: 600px) {
  .oidc-heading {
    flex-direction: column;
    gap: 10px;
  }
  .oidc-row {
    grid-template-columns: 1fr;
  }
  .oidc-issuer {
    max-width: 140px;
  }
  .oidc-dialog {
    padding: 12px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .oidc-switch span::after {
    transition: none;
  }
  .oidc-dialog::backdrop {
    backdrop-filter: none;
  }
}
</style>
