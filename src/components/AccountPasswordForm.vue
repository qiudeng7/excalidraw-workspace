<script setup lang="ts">
import { onBeforeUnmount, ref, useId } from "vue";
import { accountApi } from "~/lib/accountApi";

const props = defineProps<{ userId: string }>();
const currentPassword = ref("");
const newPassword = ref("");
const confirmation = ref("");
const busy = ref(false);
const error = ref("");
const message = ref("");
const id = useId();
let active = true;

async function submit() {
  if (busy.value) return;
  error.value = "";
  message.value = "";
  if (newPassword.value !== confirmation.value) {
    error.value = "两次输入的新密码不一致";

    return;
  }

  busy.value = true;
  try {
    await accountApi.changePassword(
      props.userId,
      currentPassword.value,
      newPassword.value,
    );
    if (!active) return;
    currentPassword.value = "";
    newPassword.value = "";
    confirmation.value = "";
    message.value = "密码已修改，其他登录会话需要重新登录。";
  } catch (cause) {
    if (active)
      error.value = cause instanceof Error ? cause.message : "修改失败，请重试";
  } finally {
    if (active) busy.value = false;
  }
}

onBeforeUnmount(() => {
  active = false;
  currentPassword.value = "";
  newPassword.value = "";
  confirmation.value = "";
});
</script>

<template>
  <form class="password-form" @submit.prevent="submit">
    <h4>修改密码</h4>
    <p>请输入原密码验证身份，新密码至少 12 位。</p>
    <label :for="`${id}-current`">原密码</label
    ><input
      :id="`${id}-current`"
      v-model="currentPassword"
      type="password"
      autocomplete="current-password"
      required
      maxlength="256"
      :disabled="busy"
    />
    <label :for="`${id}-new`">新密码</label
    ><input
      :id="`${id}-new`"
      v-model="newPassword"
      type="password"
      autocomplete="new-password"
      required
      minlength="12"
      maxlength="256"
      :disabled="busy"
    />
    <label :for="`${id}-confirm`">确认新密码</label
    ><input
      :id="`${id}-confirm`"
      v-model="confirmation"
      type="password"
      autocomplete="new-password"
      required
      minlength="12"
      maxlength="256"
      :disabled="busy"
    />
    <p v-if="error" class="password-error" role="alert">{{ error }}</p>
    <p v-if="message" class="password-success" role="status">{{ message }}</p>
    <button type="submit" :disabled="busy">
      {{ busy ? "正在修改…" : "修改密码" }}
    </button>
  </form>
</template>

<style scoped>
.password-form {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 360px;
}
h4 {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}
p {
  margin: 0 0 20px;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.8;
}
label {
  margin-bottom: 7px;
  font-size: 12px;
}
input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  margin-bottom: 17px;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface);
  color: var(--app-text);
  font: inherit;
  font-size: 13px;
}
input:focus {
  border-color: var(--app-focus);
  outline: 2px solid var(--app-focus-ring);
  outline-offset: 1px;
}
button {
  padding: 10px 18px;
  border: 0;
  border-radius: 6px;
  background: var(--app-accent);
  color: var(--app-on-accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
button:hover {
  background: var(--app-accent-hover);
}
button:focus-visible {
  outline: 2px solid var(--app-focus);
  outline-offset: 3px;
}
:disabled {
  opacity: 0.5;
  cursor: default;
}
.password-error {
  color: var(--app-danger);
  margin-bottom: 14px;
}
.password-success {
  color: var(--app-success);
  margin-bottom: 14px;
}
</style>
