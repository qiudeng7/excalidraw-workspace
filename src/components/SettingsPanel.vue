<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
} from "vue";
import type { User, UserSettings } from "#shared/contracts";
import type { UserSettingsResource } from "~/lib/userSettings";
import {
  featureControls,
  renderingControls,
  settingsStatuses,
  defaultRenderingOptions,
  readLegacySampling,
  readLegacyRenderingOptions,
} from "~/lib/settingsControls";
import QuietIcon from "~/components/QuietIcon.vue";
import ThemeSwitcher from "~/components/ThemeSwitcher.vue";
import AccountPasswordForm from "~/components/AccountPasswordForm.vue";
import ReleaseNotes from "~/components/ReleaseNotes.vue";
import { currentRelease } from "~/data/releases";

const props = defineProps<{
  resource: UserSettingsResource;
  user: User;
  registrationEnabled: boolean;
  registrationBusy: boolean;
  systemError: string;
}>();
const emit = defineEmits<{
  close: [];
  "registration-change": [event: Event];
  "release-shown": [owner: string];
}>();
const sectionDefinitions = [
  {
    key: "general",
    label: "通用",
    icon: "settings",
    description: "调整外观与日常使用偏好。",
  },
  {
    key: "features",
    label: "编辑器",
    icon: "edit",
    description: "调整 Excalidraw 编辑器的扩展功能与默认样式。",
  },
  {
    key: "account",
    label: "账号",
    icon: "user",
    description: "管理你的登录密码。",
  },
  {
    key: "updates",
    label: "更新日志",
    icon: "history",
    description: "查看当前版本与历史更新。",
  },
  {
    key: "debug",
    label: "调试",
    icon: "monitor",
    description: "调整屏幕采样和渲染方式。",
  },
  {
    key: "system",
    label: "系统设置",
    icon: "server",
    description: "管理服务设置。",
  },
] as const;

type Section = (typeof sectionDefinitions)[number]["key"];

const sections = computed(() =>
  sectionDefinitions.filter(
    (item) => item.key !== "system" || props.user.role === "admin",
  ),
);

const section = ref<Section>("general");
const current = computed(() =>
  sections.value.find((item) => item.key === section.value)!,
);
const state = computed(() => props.resource.state);
const showSyncStatus = computed(
  () =>
    section.value === "features" ||
    section.value === "debug" ||
    !state.value.ready ||
    state.value.status === "error" ||
    state.value.status === "conflict" ||
    !!state.value.cloudConflict,
);
const disabled = computed(
  () =>
    !state.value.ready ||
    !!state.value.cloudConflict ||
    state.value.status === "conflict",
);
const dialog = ref<HTMLDialogElement>();
const id = useId();
const hasLegacy = ref(false);
let returnFocus: HTMLElement | null = null;

function close() {
  void props.resource.flush();
  dialog.value?.close();
  emit("close");
}

async function navigate(event: KeyboardEvent, index: number) {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? sections.value.length - 1
        : (index +
            (event.key === "ArrowDown" ? 1 : -1) +
            sections.value.length) %
          sections.value.length;

  section.value = sections.value[next]!.key;
  await nextTick();
  dialog.value
    ?.querySelector<HTMLButtonElement>(`#${id}-tab-${section.value}`)
    ?.focus();
}

function update(settings: UserSettings) {
  if (!disabled.value) props.resource.update(settings);
}

function setFeature(key: keyof UserSettings["features"], event: Event) {
  update({
    ...state.value.settings,
    features: {
      ...state.value.settings.features,
      [key]: (event.target as HTMLInputElement).checked,
    },
  });
}

function setRendering(
  key: keyof UserSettings["debug"]["renderingOptions"],
  event: Event,
) {
  update({
    ...state.value.settings,
    debug: {
      ...state.value.settings.debug,
      renderingOptions: {
        ...state.value.settings.debug.renderingOptions,
        [key]: (event.target as HTMLInputElement).checked,
      },
    },
  });
}

function setSampling(event: Event) {
  const value = Number((event.target as HTMLSelectElement).value);

  if (value === 1 || value === 1.5 || value === 2)
    update({
      ...state.value.settings,
      debug: { ...state.value.settings.debug, sampling: value },
    });
}

function resetDebug() {
  update({
    ...state.value.settings,
    debug: { sampling: 1, renderingOptions: { ...defaultRenderingOptions } },
  });
}

function importLegacy() {
  update({
    ...state.value.settings,
    debug: {
      sampling: readLegacySampling(),
      renderingOptions: readLegacyRenderingOptions(),
    },
  });
}

onMounted(() => {
  returnFocus = document.activeElement as HTMLElement | null;
  dialog.value?.showModal();
  try {
    hasLegacy.value = !!(
      localStorage.getItem("excalidraw-demo:canvas-sampling") ||
      localStorage.getItem("excalidraw-demo:rendering-options")
    );
  } catch (error) {
    console.warn("无法检查旧本地配置，跳过可选导入入口", error);
  }
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
      class="settings-dialog"
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
      <div class="settings-card">
        <header class="settings-heading">
          <h2 :id="`${id}-title`">设置</h2>
          <button
            type="button"
            class="settings-close"
            aria-label="关闭设置"
            @click="close"
          >
            <QuietIcon name="close" :size="20" />
          </button>
        </header>
        <div class="settings-layout">
          <nav
            class="settings-nav"
            role="tablist"
            aria-label="设置分类"
            aria-orientation="vertical"
          >
            <button
              v-for="(item, index) in sections"
              :id="`${id}-tab-${item.key}`"
              :key="item.key"
              type="button"
              role="tab"
              :class="{ 'settings-admin-tab': item.key === 'system' }"
              :aria-selected="section === item.key"
              :aria-controls="`${id}-panel-${item.key}`"
              :tabindex="section === item.key ? 0 : -1"
              @click="section = item.key"
              @keydown="navigate($event, index)"
            >
              <QuietIcon :name="item.icon" :size="17" /><span>{{
                item.label
              }}</span>
            </button>
          </nav>
          <section
            :id="`${id}-panel-${section}`"
            class="settings-main"
            role="tabpanel"
            :aria-labelledby="`${id}-tab-${section}`"
            tabindex="0"
          >
            <div class="settings-section-heading">
              <h3>{{ current.label }}</h3>
              <p>{{ current.description }}</p>
            </div>
            <template v-if="section === 'features'">
              <label
                v-for="[key, label, description] in featureControls"
                :key="key"
                class="settings-row"
              >
                <span class="settings-copy"
                  ><strong>{{ label }}</strong
                  ><small>{{ description }}</small></span
                >
                <input
                  type="checkbox"
                  :aria-label="label"
                  :checked="state.settings.features[key]"
                  :disabled="disabled"
                  @change="setFeature(key, $event)"
                /><span class="settings-switch" aria-hidden="true" />
              </label>
            </template>
            <template v-else-if="section === 'debug'">
              <label class="settings-row">
                <span class="settings-copy"
                  ><strong>采样倍率</strong
                  ><small
                    >提高屏幕渲染精度，不改变缩放或导出尺寸。倍率越高，内存和渲染开销越大。</small
                  ></span
                >
                <select
                  aria-label="采样倍率"
                  :value="state.settings.debug.sampling"
                  :disabled="disabled"
                  @change="setSampling"
                >
                  <option :value="1">1×（默认）</option>
                  <option :value="1.5">1.5×</option>
                  <option :value="2">2×</option>
                </select>
              </label>
              <label
                v-for="[key, label, description] in renderingControls"
                :key="key"
                class="settings-row"
              >
                <span class="settings-copy"
                  ><strong>{{ label }}</strong
                  ><small>{{ description }}</small></span
                >
                <input
                  type="checkbox"
                  :aria-label="label"
                  :checked="state.settings.debug.renderingOptions[key]"
                  :disabled="
                    disabled ||
                    (key === 'highQualitySmoothing' &&
                      !state.settings.debug.renderingOptions.smoothCache)
                  "
                  @change="setRendering(key, $event)"
                /><span class="settings-switch" aria-hidden="true" />
              </label>
              <div class="settings-actions">
                <button type="button" :disabled="disabled" @click="resetDebug">
                  恢复调试默认</button
                ><button
                  v-if="!state.configured && hasLegacy"
                  type="button"
                  :disabled="disabled"
                  @click="importLegacy"
                >
                  导入此浏览器旧调试设置
                </button>
              </div>
            </template>
            <template v-else-if="section === 'general'">
              <div class="settings-row">
                <span class="settings-copy"
                  ><strong>外观主题</strong
                  ><small
                    >选择浅色、深色或跟随系统，保存在此浏览器。</small
                  ></span
                ><ThemeSwitcher />
              </div>
            </template>
            <ReleaseNotes
              v-else-if="section === 'updates'"
              history
              @shown="emit('release-shown', user.id)"
            />
            <template v-else-if="section === 'system'">
              <label v-if="user.role === 'admin'" class="settings-row"
                ><span class="settings-copy"
                  ><strong
                    >开放注册 <span class="settings-admin">ADMIN</span></strong
                  ><small>允许新用户创建账户。</small></span
                ><input
                  type="checkbox"
                  aria-label="开放注册"
                  :checked="registrationEnabled"
                  :disabled="registrationBusy"
                  @change="emit('registration-change', $event)" /><span
                  class="settings-switch"
                  aria-hidden="true"
              /></label>
              <p v-if="systemError" class="settings-error" role="alert">
                {{ systemError }}
              </p>
            </template>
            <template v-else>
              <div class="settings-account">
                <span class="settings-avatar"
                  ><QuietIcon name="user" :size="20"
                /></span>
                <div>
                  <strong>{{ user.name || user.email }}</strong
                  ><span>{{ user.email }}</span>
                </div>
              </div>
              <AccountPasswordForm :key="user.id" :user-id="user.id" />
            </template>
          </section>
        </div>
        <footer
          v-if="showSyncStatus"
          class="settings-footer"
          :role="state.error || state.cloudConflict ? 'alert' : 'status'"
        >
          <div>
            <span
              class="settings-sync-dot"
              :class="{ synced: state.status === 'synced' }"
            /><span>{{ settingsStatuses[state.status] }}</span
            ><small v-if="state.error">{{ state.error }}</small>
          </div>
          <div class="settings-actions">
            <button
              v-if="!state.ready"
              type="button"
              :disabled="state.status === 'loading'"
              @click="resource.load()"
            >
              重新读取设置
            </button>
            <button
              v-if="
                state.status === 'error' ||
                (state.status === 'conflict' && !state.cloudConflict)
              "
              type="button"
              @click="resource.retry()"
            >
              重试同步
            </button>
            <template v-if="state.cloudConflict"
              ><button type="button" @click="resource.useCloud()">
                采用云端设置</button
              ><button type="button" @click="resource.keepLocal()">
                保存当前设置
              </button></template
            >
          </div>
        </footer>
        <footer v-else class="settings-footer">
          <span>{{
            section === "account"
              ? "使用原密码验证身份后修改密码"
              : section === "updates"
                ? `当前版本 ${currentRelease.version} · ${currentRelease.date}`
                : "设置更改即时生效"
          }}</span>
        </footer>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.settings-dialog {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  box-sizing: border-box;
  margin: 0;
  padding: 28px;
  border: 0;
  background: transparent;
  color: var(--app-text);
  font: inherit;
}
.settings-dialog[open] {
  display: grid;
  place-items: center;
}
.settings-dialog::backdrop {
  background: var(--app-backdrop);
  backdrop-filter: blur(3px);
}
.settings-card {
  display: flex;
  flex-direction: column;
  width: min(860px, 100%);
  height: min(720px, calc(100dvh - 56px));
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: var(--app-surface);
  box-shadow: 0 24px 90px var(--app-shadow);
}
.settings-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 28px;
  border-bottom: 1px solid var(--app-border);
}
h2 {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
}
.settings-close {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
}
.settings-close:hover {
  background: var(--app-hover);
}
.settings-layout {
  display: grid;
  grid-template-columns: 166px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 20px 12px;
  background: var(--app-sidebar);
  border-right: 1px solid var(--app-border);
}
.settings-nav button {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--app-muted);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.settings-nav button:hover {
  background: var(--app-hover);
}
.settings-nav button.settings-admin-tab {
  margin-top: auto;
}
.settings-nav button[aria-selected="true"] {
  background: var(--app-selected);
  color: var(--app-selected-text);
  font-weight: 600;
}
.settings-main {
  min-width: 0;
  padding: 26px 30px;
  overflow: auto;
  outline: none;
}
.settings-section-heading {
  margin-bottom: 16px;
}
h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.settings-section-heading p {
  margin: 7px 0 0;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.7;
}
.settings-row {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 17px 0;
  border-bottom: 1px solid var(--app-border);
}
label.settings-row {
  cursor: pointer;
}
.settings-copy {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}
.settings-copy strong {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.settings-copy small {
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.8;
}
.settings-row input[type="checkbox"] {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  clip-path: inset(50%);
}
.settings-switch {
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
  border-radius: 12px;
  background: var(--app-switch);
  pointer-events: none;
}
.settings-switch::after {
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
input:checked + .settings-switch {
  background: var(--app-switch-active);
}
input:checked + .settings-switch::after {
  transform: translateX(14px);
}
input:focus-visible + .settings-switch {
  outline: 2px solid var(--app-focus);
  outline-offset: 3px;
}
input:disabled + .settings-switch {
  opacity: 0.4;
}
select {
  flex: none;
  max-width: 115px;
  padding: 8px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface);
  color: var(--app-text);
  font: inherit;
  font-size: 12px;
}
.settings-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}
.settings-actions button {
  padding: 8px 10px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface);
  color: var(--app-text);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.settings-actions button:hover {
  background: var(--app-hover);
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible,
select:focus-visible {
  outline: 2px solid var(--app-focus);
  outline-offset: 3px;
}
.settings-admin {
  margin-left: 6px;
  color: var(--app-subtle);
  font-size: 8px;
  letter-spacing: 0.08em;
}
.settings-error {
  color: var(--app-danger);
  font-size: 12px;
  line-height: 1.7;
}
.settings-account {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 0 24px;
  margin-bottom: 22px;
  border-bottom: 1px solid var(--app-border);
}
.settings-avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--app-selected);
  color: var(--app-muted);
}
.settings-account > div {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.settings-account strong {
  font-size: 13px;
  font-weight: 500;
}
.settings-account div > span {
  color: var(--app-muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.settings-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 30px;
  padding: 14px 24px;
  border-top: 1px solid var(--app-border);
  color: var(--app-muted);
  font-size: 11px;
}
.settings-footer > div:first-child {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
}
.settings-footer small {
  flex-basis: 100%;
  color: var(--app-danger);
  font-size: 11px;
  line-height: 1.7;
}
.settings-footer .settings-actions {
  flex: none;
  margin: 0;
}
.settings-sync-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--app-subtle);
}
.settings-sync-dot.synced {
  background: var(--app-switch-active);
}
@media (max-width: 600px) {
  .settings-dialog {
    padding: 12px;
  }
  .settings-card {
    height: min(760px, calc(100dvh - 24px));
    border-radius: 12px;
  }
  .settings-heading {
    padding: 18px;
  }
  .settings-layout {
    grid-template-columns: 98px minmax(0, 1fr);
  }
  .settings-nav {
    padding: 12px 6px;
  }
  .settings-nav button {
    gap: 5px;
    padding: 11px 6px;
    font-size: 11px;
  }
  .settings-nav svg {
    width: 14px;
    height: 14px;
  }
  .settings-main {
    padding: 20px 14px;
  }
  .settings-row {
    gap: 10px;
  }
  .settings-row:has(.theme-switcher) {
    align-items: flex-start;
    flex-direction: column;
  }
  .settings-copy strong {
    font-size: 12px;
  }
  .settings-copy small {
    font-size: 10px;
  }
  .settings-footer {
    flex-wrap: wrap;
    padding: 12px 16px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .settings-switch::after {
    transition: none;
  }
  .settings-dialog::backdrop {
    backdrop-filter: none;
  }
}
</style>
