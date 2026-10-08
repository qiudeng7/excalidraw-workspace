<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Bootstrap, User } from '../../shared/contracts'
import { api, ApiError } from '../lib/api'
const props = defineProps<{ bootstrap: Bootstrap }>()
const emit = defineEmits<{ authenticated: [user: User]; refresh: [] }>()
const registering = ref(false)
const email = ref('')
const password = ref('')
const name = ref('')
const busy = ref(false)
const error = ref('')
const creating = computed(() => props.bootstrap.needsSetup || registering.value)
const title = computed(() => props.bootstrap.needsSetup ? '创建管理员账户' : registering.value ? '创建账户' : '登录画布')
async function submit() {
  busy.value = true
  error.value = ''
  try {
    const endpoint = props.bootstrap.needsSetup ? 'setup' : registering.value ? 'register' : 'login'
    const { user } = await api<{ user: User }>(`/api/${endpoint}`, { method: 'POST', body: JSON.stringify({ email: email.value, password: password.value, ...(creating.value ? { name: name.value } : {}) }) })
    password.value = ''
    emit('authenticated', user)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '请求失败，请重试'
    if (cause instanceof ApiError && cause.status === 409) emit('refresh')
  } finally { busy.value = false }
}
</script>
<template>
  <section class="account-gate">
    <form class="account-card" @submit.prevent="submit">
      <h1>{{ title }}</h1>
      <p v-if="bootstrap.needsSetup">欢迎。首次使用请先创建管理员，之后可在侧边栏管理注册开关。</p>
      <p v-else>登录后，自动保存你的画布和素材库。</p>
      <label v-if="creating">昵称<input v-model="name" autocomplete="nickname" maxlength="100" required :disabled="busy" /></label>
      <label>邮箱<input v-model="email" type="email" autocomplete="username" maxlength="254" required :disabled="busy" /></label>
      <label>密码<input v-model="password" type="password" :autocomplete="creating ? 'new-password' : 'current-password'" :minlength="creating ? 12 : 1" maxlength="256" required :disabled="busy" /></label>
      <small v-if="creating">密码至少 12 位。邮箱仅用于登录，目前无需邮件验证。</small>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <button class="primary" :disabled="busy">{{ busy ? '请稍候…' : title }}</button>
      <button v-if="!bootstrap.needsSetup && bootstrap.registrationEnabled" class="switch" type="button" :disabled="busy" @click="registering = !registering; error = ''">{{ registering ? '已有账户？去登录' : '没有账户？注册' }}</button>
      <small v-else-if="!bootstrap.needsSetup">管理员已关闭新用户注册。</small>
    </form>
  </section>
</template>
<style scoped>
.account-gate{flex:1;display:grid;place-items:center;padding:24px;background:#f7f7fa;overflow:auto}.account-card{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;width:100%;max-width:380px;padding:30px;border:1px solid #e5e5eb;border-radius:16px;background:white;box-shadow:0 8px 32px #25253208}h1{font-size:24px;margin:0}p{margin:0;color:#686878;line-height:1.6}label{display:flex;flex-direction:column;gap:8px;font-size:14px}input{font:inherit;padding:10px;border:1px solid #d9d9e2;border-radius:7px;min-width:0}button{font:inherit;padding:11px;border-radius:8px;cursor:pointer}.primary{border:0;background:#6965db;color:white}.switch{background:none;border:0;color:#5753bd}small{color:#747480;line-height:1.5}.error{color:#b42318;font-size:14px}button:disabled{opacity:.6;cursor:wait}
</style>
