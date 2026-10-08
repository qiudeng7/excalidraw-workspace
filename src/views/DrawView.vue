<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import ExcalidrawCanvas from '../components/ExcalidrawCanvas.vue'
import AccountGate from '../components/AccountGate.vue'
import { api } from '../lib/api'
import type { Bootstrap, User, Workspace, CanvasMeta, CanvasDocument, LibraryDocument } from '../../shared/contracts'

const bootstrap = ref<Bootstrap>()
const user = ref<User | null>(null)
const workspaces = ref<Workspace[]>([])
const canvases = ref<CanvasMeta[]>([])
const workspaceId = ref('')
const document = shallowRef<CanvasDocument>()
const library = shallowRef<LibraryDocument>()
const editor = ref<{ flush: () => Promise<void> }>()
const busy = ref(false)
const starting = ref(true)
const error = ref('')
const saveState = ref('正在加载')
const sidebarOpen = ref(!window.matchMedia('(max-width: 760px)').matches)
const currentWorkspace = computed(() => workspaces.value.find(item => item.id === workspaceId.value))
const settingsBusy = ref(false)

async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() } catch (cause) { error.value = cause instanceof Error ? cause.message : '操作失败，请重试' }
  finally { busy.value = false }
}
async function flush() { await editor.value?.flush() }
async function loadCanvas(id: string) {
  const [canvasData, libraryData] = await Promise.all([
    api<{ canvas: CanvasDocument }>(`/api/canvases/${id}`),
    api<LibraryDocument>('/api/library'),
  ])
  library.value = libraryData
  document.value = canvasData.canvas
  saveState.value = '已保存'
  if (window.matchMedia('(max-width: 760px)').matches) sidebarOpen.value = false
}
async function loadWorkspace(id: string) {
  let { canvases: entries } = await api<{ canvases: CanvasMeta[] }>(`/api/workspaces/${id}/canvases`)
  if (!entries.length) {
    const { canvas } = await api<{ canvas: CanvasMeta }>(`/api/workspaces/${id}/canvases`, { method: 'POST', body: JSON.stringify({ name: '未命名画布' }) })
    entries = [canvas]
  }
  // 先加载新画布，失败时保留当前编辑器与侧边栏选择。
  await loadCanvas(entries[0]!.id)
  workspaceId.value = id
  canvases.value = entries
}
async function loadWorkspaces() {
  let { workspaces: entries } = await api<{ workspaces: Workspace[] }>('/api/workspaces')
  if (!entries.length) {
    const { workspace } = await api<{ workspace: Workspace }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: '我的工作空间' }) })
    entries = [workspace]
  }
  workspaces.value = entries
  await loadWorkspace(entries.find(item => item.id === workspaceId.value)?.id ?? entries[0]!.id)
}
async function initialize() {
  starting.value = true
  error.value = ''
  try {
    bootstrap.value = await api<Bootstrap>('/api/bootstrap')
    if (!bootstrap.value.needsSetup) {
      const session = await api<{ user: User | null }>('/api/session')
      user.value = session.user
      if (user.value) await loadWorkspaces()
    }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '无法连接服务' }
  finally { starting.value = false }
}
async function authenticated(account: User) {
  user.value = account
  await run(async () => {
    bootstrap.value = await api<Bootstrap>('/api/bootstrap')
    await loadWorkspaces()
  })
}
async function selectWorkspace(event: Event) {
  const select = event.target as HTMLSelectElement
  const id = select.value
  select.value = workspaceId.value
  if (id === workspaceId.value) return
  await run(async () => { await flush(); await loadWorkspace(id) })
}
async function selectCanvas(id: string) {
  if (id === document.value?.id) return
  await run(async () => { await flush(); await loadCanvas(id) })
}
async function createWorkspace() {
  const name = window.prompt('工作空间名称', '新的工作空间')?.trim()
  if (!name) return
  await run(async () => {
    await flush()
    const { workspace } = await api<{ workspace: Workspace }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })
    workspaces.value.push(workspace)
    await loadWorkspace(workspace.id)
  })
}
async function renameWorkspace() {
  const name = window.prompt('重命名工作空间', currentWorkspace.value?.name)?.trim()
  if (!name || name === currentWorkspace.value?.name) return
  await run(async () => {
    const { workspace } = await api<{ workspace: Workspace }>(`/api/workspaces/${workspaceId.value}`, { method: 'PATCH', body: JSON.stringify({ name }) })
    workspaces.value = workspaces.value.map(item => item.id === workspace.id ? workspace : item)
  })
}
async function deleteWorkspace() {
  if (!window.confirm(`删除「${currentWorkspace.value?.name}」及其中所有画布？此操作无法撤销。`)) return
  await run(async () => {
    await flush()
    await api(`/api/workspaces/${workspaceId.value}`, { method: 'DELETE' })
    document.value = undefined
    workspaceId.value = ''
    canvases.value = []
    await loadWorkspaces()
  })
}
async function createCanvas() {
  const name = window.prompt('画布名称', '未命名画布')?.trim()
  if (!name) return
  await run(async () => {
    await flush()
    const { canvas } = await api<{ canvas: CanvasMeta }>(`/api/workspaces/${workspaceId.value}/canvases`, { method: 'POST', body: JSON.stringify({ name }) })
    canvases.value.push(canvas)
    await loadCanvas(canvas.id)
  })
}
async function renameCanvas(canvas: CanvasMeta) {
  const name = window.prompt('重命名画布', canvas.name)?.trim()
  if (!name || name === canvas.name) return
  await run(async () => {
    await flush()
    const { canvas: updated } = await api<{ canvas: CanvasMeta }>(`/api/canvases/${canvas.id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
    canvases.value = canvases.value.map(item => item.id === canvas.id ? updated : item)
    if (document.value?.id === canvas.id) document.value = { ...document.value, name: updated.name }
  })
}
async function deleteCanvas(canvas: CanvasMeta) {
  if (!window.confirm(`删除画布「${canvas.name}」？此操作无法撤销。`)) return
  await run(async () => {
    await flush()
    await api(`/api/canvases/${canvas.id}`, { method: 'DELETE' })
    canvases.value = canvases.value.filter(item => item.id !== canvas.id)
    if (document.value?.id === canvas.id) {
      document.value = undefined
      await loadWorkspace(workspaceId.value)
    }
  })
}
async function logout() {
  await run(async () => {
    await flush()
    await api('/api/logout', { method: 'POST', body: '{}' })
    document.value = undefined
    library.value = undefined
    user.value = null
    workspaces.value = []
    canvases.value = []
    workspaceId.value = ''
    bootstrap.value = await api<Bootstrap>('/api/bootstrap')
  })
}
async function toggleRegistration(event: Event) {
  if (!bootstrap.value) return
  const input = event.target as HTMLInputElement
  const enabled = input.checked
  input.checked = bootstrap.value.registrationEnabled
  settingsBusy.value = true
  error.value = ''
  try {
    const settings = await api<{ registrationEnabled: boolean }>('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ registrationEnabled: enabled }) })
    bootstrap.value.registrationEnabled = settings.registrationEnabled
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '设置失败' }
  finally { settingsBusy.value = false }
}
onMounted(initialize)
</script>

<template>
  <section v-if="starting" class="loading">正在加载画布…</section>
  <section v-else-if="!bootstrap" class="loading"><p role="alert">{{ error }}</p><button @click="initialize">重试</button></section>
  <AccountGate v-else-if="!user" :bootstrap="bootstrap" @authenticated="authenticated" @refresh="initialize" />
  <section v-else class="draw-page" aria-label="Excalidraw 画布">
    <button v-if="sidebarOpen" class="sidebar-backdrop" aria-label="关闭侧边栏" @click="sidebarOpen = false" />
    <aside v-if="sidebarOpen" id="workspace-sidebar" class="workspace-sidebar" aria-label="账户与工作空间">
      <div class="sidebar-heading"><strong>我的画布</strong><button title="收起侧边栏" aria-label="收起侧边栏" @click="sidebarOpen = false">‹</button></div>
      <div class="account-info"><strong>{{ user.name || user.email }}</strong><small>{{ user.email }}</small><button :disabled="busy" @click="logout">退出登录</button></div>
      <div class="workspace-controls">
        <label for="workspace-select">工作空间</label>
        <select id="workspace-select" :value="workspaceId" :disabled="busy" @change="selectWorkspace"><option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option></select>
        <div class="button-row"><button :disabled="busy" @click="createWorkspace">新建</button><button :disabled="busy || !workspaceId" @click="renameWorkspace">重命名</button><button :disabled="busy || !workspaceId" @click="deleteWorkspace">删除</button></div>
      </div>
      <div class="canvas-heading"><strong>画布</strong><button :disabled="busy || !workspaceId" @click="createCanvas">＋ 新建</button></div>
      <ul class="canvas-list">
        <li v-for="canvas in canvases" :key="canvas.id" :class="{ selected: document?.id === canvas.id }">
          <button class="canvas-name" :title="canvas.name" :aria-current="document?.id === canvas.id ? 'page' : undefined" :disabled="busy" @click="selectCanvas(canvas.id)">{{ canvas.name }}</button>
          <button class="icon-button" :aria-label="`重命名画布 ${canvas.name}`" title="重命名" :disabled="busy" @click="renameCanvas(canvas)">改</button>
          <button class="icon-button" :aria-label="`删除画布 ${canvas.name}`" title="删除" :disabled="busy" @click="deleteCanvas(canvas)">×</button>
        </li>
      </ul>
      <div v-if="user.role === 'admin'" class="admin-settings"><strong>管理员设置</strong><label><input type="checkbox" :checked="bootstrap.registrationEnabled" :disabled="settingsBusy" @change="toggleRegistration" />允许新用户注册</label></div>
      <small class="sidebar-note">画布与素材库自动保存到你的账户。</small>
    </aside>
    <div class="draw-content">
      <header class="canvas-header"><button :aria-expanded="sidebarOpen" aria-controls="workspace-sidebar" @click="sidebarOpen = !sidebarOpen">☰ <span>工作空间</span></button><span class="document-name">{{ document?.name ?? '我的画布' }}</span><span class="save-state" role="status">{{ busy ? '处理中…' : saveState }}</span></header>
      <div v-if="error" class="operation-error" role="alert"><span>{{ error }}</span><button v-if="!document" :disabled="busy" @click="run(loadWorkspaces)">重新加载</button><button aria-label="关闭提示" @click="error = ''">×</button></div>
      <div v-if="document && library" class="draw-editor" :inert="busy"><ExcalidrawCanvas :key="document.id" ref="editor" :document="document" :library="library" :user-id="user.id" @save-state="saveState = $event" /></div>
      <div v-else class="loading">{{ busy ? '正在加载画布…' : '暂时无法加载画布，请重试。' }}</div>
    </div>
  </section>
</template>

<style scoped>
.draw-page{position:relative;flex:1;min-height:0;display:flex;overflow:hidden;background:#fff}.draw-content{position:relative;isolation:isolate;flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}.draw-editor{flex:1;min-height:0}.loading{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:#686878}.workspace-sidebar{box-sizing:border-box;flex:none;width:256px;display:flex;flex-direction:column;gap:18px;overflow:auto;padding:16px;background:#fafafa;border-right:1px solid #e8e8ed;z-index:20}.sidebar-heading,.canvas-heading,.button-row,.canvas-header{display:flex;align-items:center;justify-content:space-between;gap:8px}.sidebar-heading{font-size:17px}.account-info{display:flex;flex-direction:column;gap:6px;min-width:0}.account-info strong,.account-info small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.account-info button{align-self:flex-start}.workspace-controls{display:flex;flex-direction:column;gap:9px}.workspace-controls label,.canvas-heading,.admin-settings strong{font-size:13px;color:#696975}.workspace-controls select{width:100%;padding:9px;border:1px solid #dddde5;border-radius:7px;background:white;font:inherit;color:inherit}.button-row button{flex:1;padding:6px 3px;font-size:12px}.canvas-list{list-style:none;margin:-10px 0 0;padding:0;display:flex;flex-direction:column;gap:4px;flex:1;min-height:60px}.canvas-list li{display:flex;align-items:center;border-radius:7px;min-height:37px}.canvas-list .selected{background:#eeedfd;color:#5753bd}.canvas-list button{background:transparent;border:0}.canvas-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}.icon-button{padding:7px 5px!important;flex:none}.admin-settings{border-top:1px solid #e3e3e9;padding-top:16px;display:flex;flex-direction:column;gap:12px}.admin-settings label{font-size:13px;display:flex;gap:7px;align-items:center}.sidebar-note,small{font-size:12px;color:#80808b;line-height:1.6}.canvas-header{flex:none;height:42px;box-sizing:border-box;padding:5px 12px;border-bottom:1px solid #eeeef3;font-size:12px;color:#72727f}.canvas-header button{font-size:12px}.document-name{flex:1;min-width:0;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}.save-state{flex:none;font-size:11px}button{cursor:pointer;border:1px solid #e2e2e9;background:white;border-radius:6px;padding:6px 9px;font:inherit;color:inherit}button:hover{background:#f0eff8}button:disabled{opacity:.5;cursor:wait}.operation-error{padding:8px 12px;background:#fff1f0;color:#b42318;font-size:13px;display:flex;align-items:center;gap:8px}.operation-error span{flex:1}.sidebar-backdrop{display:none}@media(max-width:760px){.workspace-sidebar{position:absolute;inset:0 auto 0 0;width:min(300px,85vw);box-shadow:8px 0 24px #0002;z-index:40}.sidebar-backdrop{display:block;position:absolute;inset:0;border:0;border-radius:0;background:#0004;z-index:39}.canvas-header{padding-inline:8px}.canvas-header button span{display:none}.save-state{max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
</style>
