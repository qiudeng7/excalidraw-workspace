<script setup lang="ts">
import { computed, ref } from "vue";
import QuietIcon from "./QuietIcon.vue";
import type { Bootstrap, User } from "../../shared/contracts";
import { ApiError } from "../lib/api";
import { accountApi } from "../lib/accountApi";

const props = defineProps<{ bootstrap: Bootstrap }>();
const emit = defineEmits<{ authenticated: [user: User]; refresh: [] }>();
const registering = ref(false);
const email = ref("");
const password = ref("");
const name = ref("");
const busy = ref(false);
const error = ref("");
const creating = computed(
  () => props.bootstrap.needsSetup || registering.value,
);
const title = computed(() =>
  props.bootstrap.needsSetup
    ? "创建管理员账户"
    : registering.value
      ? "创建账户"
      : "登录画布",
);

async function submit() {
  busy.value = true;
  error.value = "";
  try {
    const endpoint = props.bootstrap.needsSetup
      ? "setup"
      : registering.value
        ? "register"
        : "login";
    const user = await accountApi.authenticate(endpoint, {
      email: email.value,
      password: password.value,
      ...(creating.value ? { name: name.value } : {}),
    });

    password.value = "";
    emit("authenticated", user);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "请求失败，请重试";
    if (cause instanceof ApiError && cause.status === 409) emit("refresh");
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="account-gate">
    <div class="welcome-panel">
      <a class="wordmark" href="/">
        <span class="brand-symbol"><QuietIcon name="canvas" :size="19" /></span>
        画布空间 <span class="wordmark-detail">EXCALIDRAW</span></a
      >
      <div class="welcome-copy">
        <span class="eyebrow">A SPACE FOR YOUR IDEAS</span>
        <h2>让想法<br />有一个安静的地方。</h2>
        <p>从一笔草图到完整的构想。<br />你的画布、素材与灵感，都在这里。</p>
        <svg
          class="idea-diagram"
          viewBox="0 0 400 190"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M75 95h78m70 0h94"
            stroke="var(--app-subtle)"
            stroke-width="1.5"
          />
          <path
            d="m146 89 7 6-7 6m164-12 7 6-7 6"
            stroke="var(--app-subtle)"
            stroke-width="1.5"
          />
          <rect
            x="15"
            y="65"
            width="60"
            height="60"
            rx="12"
            stroke="var(--app-subtle)"
            stroke-width="1.5"
          />
          <path
            d="M34 85h22M34 94h22M34 103h12"
            stroke="var(--app-subtle)"
            stroke-width="1.5"
          />
          <rect
            x="156"
            y="57"
            width="75"
            height="75"
            rx="18"
            stroke="var(--app-text)"
            stroke-width="1.5"
          />
          <path
            d="m178 95 10 10 20-22"
            stroke="var(--app-text)"
            stroke-width="2"
          />
          <circle
            cx="346"
            cy="95"
            r="29"
            stroke="var(--app-subtle)"
            stroke-width="1.5"
          />
          <path
            d="M193 57V28H330v38"
            stroke="var(--app-border)"
            stroke-width="1.5"
            stroke-dasharray="4 5"
          />
        </svg>
      </div>
      <span class="welcome-footer"
        >随时回来，接着画。<span>自动保存 · 私人空间</span></span
      >
    </div>
    <div class="form-panel">
      <ThemeSwitcher class="account-theme-switcher" />
      <form class="account-card" @submit.prevent="submit">
        <span class="form-kicker">{{
          bootstrap.needsSetup ? "首次使用" : creating ? "新的开始" : "欢迎回来"
        }}</span>
        <h1>{{ title }}</h1>
        <p v-if="bootstrap.needsSetup" class="intro">
          先创建管理员账户，开启你的画布空间。注册权限可在侧边栏随时调整。
        </p>
        <p v-else class="intro">
          {{
            creating
              ? "创建一个账户，把想法留在这里。"
              : "登录后，继续你的创作。"
          }}
        </p>
        <div class="fields">
          <label v-if="creating"
            >昵称<input
              v-model="name"
              autocomplete="nickname"
              placeholder="怎么称呼你"
              maxlength="100"
              required
              :disabled="busy"
          /></label>
          <label
            >邮箱<input
              v-model="email"
              type="email"
              autocomplete="username"
              placeholder="you@example.com"
              maxlength="254"
              required
              :disabled="busy"
          /></label>
          <label
            >密码<input
              v-model="password"
              type="password"
              :placeholder="creating ? '至少 12 位' : '输入你的密码'"
              :autocomplete="creating ? 'new-password' : 'current-password'"
              :minlength="creating ? 12 : 1"
              maxlength="256"
              required
              :disabled="busy"
          /></label>
        </div>
        <small v-if="creating"
          >邮箱仅用于登录，无需邮件验证。密码至少 12 位。</small
        >
        <p v-if="error" role="alert" class="error">{{ error }}</p>
        <button class="primary" :disabled="busy">
          <span>{{
            busy ? "请稍候…" : creating ? "创建并进入" : "进入我的空间"
          }}</span
          ><QuietIcon name="arrow" />
        </button>
        <div class="form-bottom">
          <template
            v-if="!bootstrap.needsSetup && bootstrap.registrationEnabled"
            ><span>{{ registering ? "已经有账户？" : "第一次来到这里？" }}</span
            ><button
              class="switch"
              type="button"
              :disabled="busy"
              @click="
                registering = !registering;
                error = '';
              "
            >
              {{ registering ? "登录" : "创建账户" }}
            </button></template
          >
          <small v-else-if="!bootstrap.needsSetup"
            >管理员已关闭新用户注册。</small
          >
          <small v-else>首个账户将成为此服务的管理员。</small>
        </div>
      </form>
      <span class="form-footnote"
        ><QuietIcon name="cloud" :size="14" />
        画布与素材库，自动保存到你的账户</span
      >
    </div>
  </section>
</template>
<style scoped>
.account-gate {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  background: var(--app-surface);
  color: var(--app-text);
  overflow: auto;
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}
.welcome-panel {
  display: flex;
  flex-direction: column;
  padding: 42px 56px;
  background: var(--app-welcome);
  min-height: 580px;
  box-sizing: border-box;
}
.wordmark {
  display: flex;
  align-items: center;
  gap: 10px;
  color: inherit;
  text-decoration: none;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.brand-symbol {
  display: grid;
  place-items: center;
  background: var(--app-accent);
  color: var(--app-on-accent);
  width: 31px;
  height: 31px;
  border-radius: 7px;
}
.wordmark-detail {
  margin-left: auto;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.16em;
  color: var(--app-subtle);
}
.welcome-copy {
  margin: auto 0;
  padding: 56px 0 30px;
}
.eyebrow {
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--app-subtle);
  font-weight: 600;
}
h2 {
  font-size: clamp(32px, 3.3vw, 50px);
  font-weight: 500;
  line-height: 1.55;
  letter-spacing: 0.05em;
  margin: 20px 0 22px;
}
.welcome-copy p {
  font-size: 14px;
  line-height: 1.95;
  color: var(--app-muted);
}
.idea-diagram {
  display: block;
  width: 100%;
  max-width: 400px;
  margin-top: 20px;
}
.welcome-footer {
  font-size: 11px;
  color: var(--app-subtle);
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.form-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 28px;
  box-sizing: border-box;
  gap: 48px;
}
.account-theme-switcher {
  position: absolute;
  top: 24px;
  right: 28px;
}
.account-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 336px;
}
.form-kicker {
  font-size: 12px;
  color: var(--app-subtle);
  letter-spacing: 0.08em;
}
h1 {
  font-size: 27px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 10px 0 12px;
}
.intro {
  font-size: 13px;
  line-height: 1.8;
  color: var(--app-muted);
  margin: 0 0 30px;
}
.fields {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 9px;
  font-size: 12px;
  font-weight: 500;
  color: var(--app-text);
}
input {
  font: inherit;
  font-size: 14px;
  box-sizing: border-box;
  width: 100%;
  height: 44px;
  padding: 0 13px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  outline: none;
  background: var(--app-surface);
  color: var(--app-text);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
input::placeholder {
  color: var(--app-subtle);
}
input:focus {
  border-color: var(--app-focus);
  box-shadow: 0 0 0 3px var(--app-focus-ring);
}
small {
  font-size: 11px;
  line-height: 1.7;
  color: var(--app-subtle);
  margin-top: 12px;
}
button {
  font: inherit;
  cursor: pointer;
}
.primary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 45px;
  padding: 0 15px;
  border: 0;
  border-radius: 6px;
  background: var(--app-accent);
  color: var(--app-on-accent);
  font-size: 13px;
  margin-top: 26px;
}
.primary:hover {
  background: var(--app-accent-hover);
}
.form-bottom {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  color: var(--app-subtle);
  margin-top: 24px;
}
.form-bottom small {
  margin: 0;
}
.switch {
  padding: 4px 0;
  background: none;
  border: 0;
  color: var(--app-selected-text);
  font-size: 12px;
  font-weight: 600;
}
.switch:hover {
  text-decoration: underline;
}
.error {
  color: var(--app-danger);
  font-size: 12px;
  background: var(--app-danger-bg);
  padding: 10px 12px;
  border-radius: 5px;
  margin: 16px 0 0;
}
.form-footnote {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
  color: var(--app-subtle);
}
button:disabled {
  opacity: 0.6;
  cursor: wait;
}
@media (min-width: 1500px) {
  .welcome-panel {
    padding-inline: 80px;
  }
  .welcome-copy {
    max-width: 530px;
  }
}
@media (max-width: 850px) {
  .account-gate {
    grid-template-columns: 0.85fr 1fr;
  }
  .welcome-panel {
    padding: 32px;
  }
  .wordmark-detail {
    display: none;
  }
  .welcome-footer span {
    display: none;
  }
  h2 {
    font-size: 32px;
  }
  .idea-diagram {
    margin-top: 12px;
  }
}
@media (max-width: 620px) {
  .account-gate {
    grid-template-columns: 1fr;
  }
  .welcome-panel {
    min-height: 0;
    padding: 24px;
    background: var(--app-surface);
  }
  .welcome-copy,
  .welcome-footer {
    display: none;
  }
  .form-panel {
    padding: 70px 28px 40px;
    justify-content: flex-start;
    gap: 44px;
  }
  .account-card {
    max-width: 380px;
  }
  .intro {
    margin-bottom: 26px;
  }
  .form-footnote {
    margin-top: 0;
  }
}
</style>
