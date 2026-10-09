<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import ExcalidrawCanvas from '../components/ExcalidrawCanvas.vue'
import AccountGate from '../components/AccountGate.vue'
import QuietIcon from '../components/QuietIcon.vue'
import { api } from '../lib/api'
import { cancelAppDialog, confirmDialog, promptDialog } from '../lib/dialogs'
import type { Bootstrap, User, Workspace, CanvasMeta, CanvasDocument, LibraryDocument } from '../../shared/contracts'

const bootstrap = ref<Bootstrap>()
const user = ref<User | null>(null)
const workspaces = ref<Workspace[]>([])
const canvases = ref<CanvasMeta[]>([])
const workspaceId = ref('')
const document = shallowRef<CanvasDocument>()
const library = shallowRef<LibraryDocument>()
const editor = ref<{ flush: () => Promise<void>; saveManually: () => Promise<void> }>()
const busy = ref(false)
const starting = ref(true)
const error = ref('')
const saveState = ref('正在加载')
const sidebarOpen = ref(!window.matchMedia('(max-width: 760px)').matches)
const currentWorkspace = computed(() => workspaces.value.find(item => item.id === workspaceId.value))
const settingsBusy = ref(false)
const workspacePicker = ref<HTMLElement>()
const workspaceTrigger = ref<HTMLButtonElement>()
const workspaceList = ref<HTMLUListElement>()
const workspaceMenuOpen = ref(false)
const activeWorkspaceIndex = ref(0)

function closeWorkspaceMenu(returnFocus = false) {
  workspaceMenuOpen.value = false
  if (returnFocus) workspaceTrigger.value?.focus()
}
async function openWorkspaceMenu(index?: number) {
  if (busy.value || !workspaces.value.length) return
  activeWorkspaceIndex.value = index ?? Math.max(0, workspaces.value.findIndex(item => item.id === workspaceId.value))
  workspaceMenuOpen.value = true
  await nextTick()
  workspaceList.value?.focus()
  scrollActiveWorkspace()
}
function scrollActiveWorkspace() {
  workspaceList.value?.children[activeWorkspaceIndex.value]?.scrollIntoView({ block: 'nearest' })
}
function handleWorkspaceTriggerKey(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.stopPropagation()
  event.preventDefault()
  void openWorkspaceMenu(event.key === 'Home' ? 0 : event.key === 'End' ? workspaces.value.length - 1 : undefined)
}
function handleWorkspaceListKey(event: KeyboardEvent) {
  if (['Tab', 'Escape', 'Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) event.stopPropagation()
  if (event.key === 'Tab') { closeWorkspaceMenu(true); return }
  if (event.key === 'Escape') { event.preventDefault(); closeWorkspaceMenu(true); return }
  if (busy.value) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    const workspace = workspaces.value[activeWorkspaceIndex.value]
    if (workspace) void selectWorkspace(workspace.id)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const last = workspaces.value.length - 1
  activeWorkspaceIndex.value = event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0, Math.min(last, activeWorkspaceIndex.value + (event.key === 'ArrowDown' ? 1 : -1)))
  void nextTick(scrollActiveWorkspace)
}
function dismissWorkspaceMenu(event: PointerEvent) {
  if (workspaceMenuOpen.value && !workspacePicker.value?.contains(event.target as Node)) closeWorkspaceMenu()
}
function escapeWorkspaceMenu(event: KeyboardEvent) {
  if (workspaceMenuOpen.value && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeWorkspaceMenu(true) }
}
function handleWorkspaceFocusOut(event: FocusEvent) {
  if (event.relatedTarget && !workspacePicker.value?.contains(event.relatedTarget as Node)) closeWorkspaceMenu()
}
watch([busy, sidebarOpen], ([isBusy, isOpen]) => {
  if (isBusy || !isOpen) closeWorkspaceMenu()
})
const saveShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ S' : 'Ctrl S'

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
async function selectWorkspace(id: string) {
  if (busy.value) return
  closeWorkspaceMenu(true)
  if (id === workspaceId.value) return
  await run(async () => { await flush(); await loadWorkspace(id) })
}
async function selectCanvas(id: string) {
  if (id === document.value?.id) return
  await run(async () => { await flush(); await loadCanvas(id) })
}
async function createWorkspace() {
  const name = await promptDialog({ title: '新建工作空间', label: '工作空间名称', initialValue: '新的工作空间', confirmLabel: '创建' })
  if (!name) return
  await run(async () => {
    await flush()
    const { workspace } = await api<{ workspace: Workspace }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })
    workspaces.value.push(workspace)
    await loadWorkspace(workspace.id)
  })
}
async function renameWorkspace() {
  const name = await promptDialog({ title: '重命名工作空间', label: '工作空间名称', initialValue: currentWorkspace.value?.name, confirmLabel: '保存名称' })
  if (!name || name === currentWorkspace.value?.name) return
  await run(async () => {
    const { workspace } = await api<{ workspace: Workspace }>(`/api/workspaces/${workspaceId.value}`, { method: 'PATCH', body: JSON.stringify({ name }) })
    workspaces.value = workspaces.value.map(item => item.id === workspace.id ? workspace : item)
  })
}
async function deleteWorkspace() {
  if (!await confirmDialog({ title: '删除工作空间', message: `删除「${currentWorkspace.value?.name}」及其中所有画布？此操作无法撤销。`, confirmLabel: '删除工作空间', danger: true })) return
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
  const name = await promptDialog({ title: '新建画布', label: '画布名称', initialValue: '未命名画布', confirmLabel: '创建' })
  if (!name) return
  await run(async () => {
    await flush()
    const { canvas } = await api<{ canvas: CanvasMeta }>(`/api/workspaces/${workspaceId.value}/canvases`, { method: 'POST', body: JSON.stringify({ name }) })
    canvases.value.push(canvas)
    await loadCanvas(canvas.id)
  })
}
async function renameCanvas(canvas: CanvasMeta) {
  const name = await promptDialog({ title: '重命名画布', label: '画布名称', initialValue: canvas.name, confirmLabel: '保存名称' })
  if (!name || name === canvas.name) return
  await run(async () => {
    await flush()
    const { canvas: updated } = await api<{ canvas: CanvasMeta }>(`/api/canvases/${canvas.id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
    canvases.value = canvases.value.map(item => item.id === canvas.id ? updated : item)
    if (document.value?.id === canvas.id) document.value = { ...document.value, name: updated.name }
  })
}
async function deleteCanvas(canvas: CanvasMeta) {
  if (!await confirmDialog({ title: '删除画布', message: `删除画布「${canvas.name}」？此操作无法撤销。`, confirmLabel: '删除画布', danger: true })) return
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
function closeActionMenu(event: MouseEvent) {
  const button = (event.target as HTMLElement).closest('button')
  if (button && !button.disabled) button.closest('details')?.removeAttribute('open')
}
onMounted(() => {
  void initialize()
  window.document.addEventListener('pointerdown', dismissWorkspaceMenu)
  window.document.addEventListener('keydown', escapeWorkspaceMenu)
})
onBeforeUnmount(() => {
  cancelAppDialog()
  window.document.removeEventListener('pointerdown', dismissWorkspaceMenu)
  window.document.removeEventListener('keydown', escapeWorkspaceMenu)
})
</script>

<template>
  <section v-if="starting" class="loading"><span class="loading-mark" /><span>正在打开你的空间…</span></section>
  <section v-else-if="!bootstrap" class="loading"><p role="alert">{{ error }}</p><button @click="initialize">重试连接</button></section>
  <AccountGate v-else-if="!user" :bootstrap="bootstrap" @authenticated="authenticated" @refresh="initialize" />
  <section v-else class="draw-page" aria-label="Excalidraw 画布">
    <button v-if="sidebarOpen" class="sidebar-backdrop" aria-label="关闭侧边栏" @click="sidebarOpen = false" />
    <aside v-if="sidebarOpen" id="workspace-sidebar" class="workspace-sidebar" aria-label="账户与工作空间">
      <div class="sidebar-heading"><span class="workspace-brand"><span class="brand-symbol"><QuietIcon name="canvas" :size="17" /></span>画布空间</span><button class="icon-button" title="收起侧边栏" aria-label="收起侧边栏" @click="sidebarOpen = false"><QuietIcon name="panel" :size="17" /></button></div>
      <div class="workspace-controls">
        <div class="section-label"><label id="workspace-picker-label" for="workspace-select">工作空间</label><details class="action-menu"><summary aria-label="工作空间操作" title="工作空间操作"><QuietIcon name="more" :size="17" /></summary><div class="menu-popover" @click="closeActionMenu"><button :disabled="busy" @click="createWorkspace"><QuietIcon name="plus" :size="15" />新建工作空间</button><button :disabled="busy || !workspaceId" @click="renameWorkspace"><QuietIcon name="edit" :size="15" />重命名</button><button class="danger" :disabled="busy || !workspaceId" @click="deleteWorkspace"><QuietIcon name="trash" :size="15" />删除工作空间</button></div></details></div>
        <div ref="workspacePicker" class="workspace-picker" @focusout="handleWorkspaceFocusOut">
          <button id="workspace-select" ref="workspaceTrigger" class="workspace-select-wrap" :class="{ expanded: workspaceMenuOpen }" :disabled="busy || !workspaces.length" aria-haspopup="listbox" :aria-expanded="workspaceMenuOpen" aria-controls="workspace-options" aria-labelledby="workspace-picker-label workspace-current-name" @click="workspaceMenuOpen ? closeWorkspaceMenu() : openWorkspaceMenu()" @keydown="handleWorkspaceTriggerKey">
            <QuietIcon name="folder" :size="16" /><span id="workspace-current-name" :title="currentWorkspace?.name">{{ currentWorkspace?.name ?? '选择工作空间' }}</span><svg class="workspace-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
          <ul v-if="workspaceMenuOpen" id="workspace-options" ref="workspaceList" class="workspace-options" role="listbox" tabindex="0" aria-labelledby="workspace-picker-label" :aria-activedescendant="`workspace-option-${activeWorkspaceIndex}`" @keydown="handleWorkspaceListKey">
            <li v-for="(workspace, index) in workspaces" :id="`workspace-option-${index}`" :key="workspace.id" role="option" :aria-selected="workspace.id === workspaceId" :aria-disabled="busy" :class="{ active: activeWorkspaceIndex === index, chosen: workspace.id === workspaceId }" :title="workspace.name" @pointermove="activeWorkspaceIndex = index" @click="selectWorkspace(workspace.id)">
              <QuietIcon name="folder" :size="15" /><span>{{ workspace.name }}</span><QuietIcon v-if="workspace.id === workspaceId" name="check" :size="15" />
            </li>
          </ul>
        </div>
      </div>
      <div class="canvas-heading"><span>画布 <span class="count">{{ canvases.length }}</span></span><button class="icon-button" title="新建画布" aria-label="新建画布" :disabled="busy || !workspaceId" @click="createCanvas"><QuietIcon name="plus" :size="16" /></button></div>
      <ul class="canvas-list">
        <li v-for="canvas in canvases" :key="canvas.id" :class="{ selected: document?.id === canvas.id }">
          <button class="canvas-name" :title="canvas.name" :aria-current="document?.id === canvas.id ? 'page' : undefined" :disabled="busy" @click="selectCanvas(canvas.id)"><QuietIcon name="canvas" :size="16" /><span>{{ canvas.name }}</span></button>
          <details class="action-menu canvas-menu"><summary :aria-label="`画布 ${canvas.name} 的操作`" title="画布操作"><QuietIcon name="more" :size="16" /></summary><div class="menu-popover" @click="closeActionMenu"><button :aria-label="`重命名画布 ${canvas.name}`" :disabled="busy" @click="renameCanvas(canvas)"><QuietIcon name="edit" :size="15" />重命名</button><button class="danger" :aria-label="`删除画布 ${canvas.name}`" :disabled="busy" @click="deleteCanvas(canvas)"><QuietIcon name="trash" :size="15" />删除画布</button></div></details>
        </li>
      </ul>
      <div class="sidebar-bottom">
        <div v-if="user.role === 'admin'" class="admin-settings"><div class="section-label"><strong>管理设置</strong><span class="admin-badge">ADMIN</span></div><label class="registration-switch"><span><span>开放注册</span><small>允许新用户创建账户</small></span><input type="checkbox" :checked="bootstrap.registrationEnabled" :disabled="settingsBusy" @change="toggleRegistration" /><span class="switch-track" aria-hidden="true" /></label></div>
        <div class="account-info"><span class="avatar">{{ (user.name || user.email).slice(0, 1).toUpperCase() }}</span><div class="account-text"><strong>{{ user.name || user.email }}</strong><small :title="user.email">{{ user.email }}</small></div><button class="icon-button" title="退出登录" aria-label="退出登录" :disabled="busy" @click="logout"><QuietIcon name="logout" :size="17" /></button></div>
      </div>
    </aside>
    <div class="draw-content">
      <header class="canvas-header"><button class="sidebar-toggle icon-button" :aria-expanded="sidebarOpen" aria-controls="workspace-sidebar" aria-label="切换工作空间侧边栏" title="工作空间" @click="sidebarOpen = !sidebarOpen"><QuietIcon name="panel" :size="18" /></button><div class="breadcrumb"><span class="workspace-crumb">{{ currentWorkspace?.name }}</span><span class="crumb-divider">/</span><span class="document-name">{{ document?.name ?? '我的画布' }}</span></div><div class="header-right"><span class="save-state" :class="{ saved: saveState === '已保存' && !busy }" role="status"><span class="status-dot" />{{ busy ? '处理中…' : saveState }}</span><button class="save-button" :disabled="busy || !document" title="保存画布 · Ctrl / ⌘ S" @click="editor?.saveManually()"><QuietIcon name="cloud" :size="15" /><span>保存</span><kbd>{{ saveShortcut }}</kbd></button></div></header>
      <div v-if="error" class="operation-error" role="alert"><span>{{ error }}</span><button v-if="!document" :disabled="busy" @click="run(loadWorkspaces)">重新加载</button><button class="icon-button" aria-label="关闭提示" @click="error = ''"><QuietIcon name="close" :size="16" /></button></div>
      <div v-if="document && library" class="draw-editor" :inert="busy"><ExcalidrawCanvas :key="document.id" ref="editor" :document="document" :library="library" :user-id="user.id" @save-state="saveState = $event" /></div>
      <div v-else class="loading">{{ busy ? '正在加载画布…' : '暂时无法加载画布，请重试。' }}</div>
    </div>
  </section>
</template>

<style scoped>
.draw-page{--text:#303632;--muted:#8d958d;--line:#e9ece7;position:relative;flex:1;min-height:0;display:flex;overflow:hidden;background:#fff;color:var(--text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.draw-content{position:relative;isolation:isolate;flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}.draw-editor{flex:1;min-height:0}.loading{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font-size:13px;color:#7c857c}.loading-mark{width:18px;height:18px;border:2px solid #e7ece5;border-top-color:#546653;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.workspace-sidebar{box-sizing:border-box;flex:none;width:248px;display:flex;flex-direction:column;padding:0 14px;background:#f8f9f6;border-right:1px solid var(--line);z-index:20;overflow:auto}.sidebar-heading{display:flex;align-items:center;justify-content:space-between;height:68px;flex:none;padding:0 4px}.workspace-brand{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:600;letter-spacing:.03em}.brand-symbol{display:grid;place-items:center;width:28px;height:28px;background:#354237;color:#fff;border-radius:6px}.workspace-controls{margin-top:15px;margin-bottom:24px}.section-label,.canvas-heading{display:flex;align-items:center;justify-content:space-between;color:#727d70;font-size:11px;letter-spacing:.04em}.section-label{padding:0 8px;margin-bottom:8px}.section-label strong{font-weight:500}.workspace-picker{position:relative}.workspace-select-wrap{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;padding:0 11px;height:38px;border:1px solid #e1e6df;border-radius:6px;background:white;color:#707a6f;text-align:left}.workspace-select-wrap>svg{flex:none}.workspace-select-wrap>span{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;color:#414b40}.workspace-select-wrap:hover{background:#fcfdfb;border-color:#cad4c5}.workspace-select-wrap.expanded{border-color:#8b9d88;box-shadow:0 0 0 2px #84937d12}.workspace-chevron{width:12px;height:12px;transition:transform .15s}.expanded .workspace-chevron{transform:rotate(180deg)}.workspace-options{position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:37;box-sizing:border-box;margin:0;padding:4px;list-style:none;background:#fff;border:1px solid #e0e5dc;border-radius:7px;box-shadow:0 6px 24px #26302516;max-height:min(280px,calc(100dvh - 180px));overflow-y:auto;outline:none;overscroll-behavior:contain}.workspace-options li{display:flex;align-items:center;gap:8px;padding:10px 8px;border-radius:4px;color:#747f6d;font-size:12px;cursor:pointer}.workspace-options li>svg{flex:none}.workspace-options li>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#53604c}.workspace-options li.active{background:#eff3eb}.workspace-options li.chosen>span{font-weight:500;color:#34432e}.workspace-options:focus-visible li.active{box-shadow:inset 0 0 0 1px #d3dec9}.workspace-options li[aria-disabled="true"]{opacity:.5;cursor:wait}.canvas-heading{padding:0 8px;margin-bottom:7px}.count{margin-left:5px;color:#b0b7ad;font-size:10px}.canvas-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;flex:1;min-height:110px}.canvas-list li{display:flex;align-items:center;border-radius:5px;min-height:37px;padding-right:3px;color:#7c867a}.canvas-list li:hover{background:#eff2ec}.canvas-list .selected{background:#e9eee5;color:#34432e}.canvas-name{display:flex;align-items:center;gap:9px;flex:1;min-width:0;text-align:left;padding:10px 10px!important;font-size:13px!important;background:none!important}.canvas-name svg{flex:none}.canvas-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.canvas-menu{flex:none;color:#9ca496}.action-menu{position:relative}.action-menu summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:4px;outline:none}.action-menu summary::-webkit-details-marker{display:none}.action-menu summary:hover,.action-menu[open] summary{background:#e4e9e0;color:#45513f}.action-menu summary:focus-visible{outline:2px solid #7d9277;outline-offset:1px}.action-menu[open]{z-index:35}.menu-popover{position:absolute;right:0;top:30px;min-width:158px;padding:4px;background:white;border:1px solid #e0e5dc;box-shadow:0 6px 24px #26302516;border-radius:7px;z-index:36}.menu-popover button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:9px 8px;font-size:11px;white-space:nowrap}.menu-popover .danger{color:#a26355}.sidebar-bottom{margin-top:26px;flex:none}.admin-settings{padding:16px 0 19px;border-top:1px solid var(--line)}.admin-badge{font-size:8px;letter-spacing:.09em;color:#969f91}.registration-switch{display:flex;align-items:center;gap:8px;padding:4px 8px 0;font-size:12px;cursor:pointer}.registration-switch>span:first-child{display:flex;flex:1;flex-direction:column;gap:5px}.registration-switch small{font-size:10px;color:#7f8c77}.registration-switch input{position:absolute;opacity:0;width:1px;height:1px;clip-path:inset(50%)}.switch-track{flex:none;width:28px;height:16px;border-radius:10px;background:#d5ddcf;position:relative;pointer-events:none}.switch-track::after{content:'';position:absolute;width:12px;height:12px;top:2px;left:2px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 3px #0002}.registration-switch input:checked+.switch-track{background:#617a56}.registration-switch input:checked+.switch-track::after{transform:translateX(12px)}.registration-switch input:focus-visible+.switch-track{outline:2px solid #617a56;outline-offset:3px}.registration-switch input:disabled+.switch-track{opacity:.5}.account-info{display:flex;align-items:center;gap:9px;padding:17px 5px;border-top:1px solid var(--line)}.avatar{display:grid;place-items:center;width:30px;height:30px;flex:none;border-radius:50%;background:#e4e9df;color:#63755a;font-size:11px;font-weight:600}.account-text{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}.account-text strong,.account-text small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.account-text strong{font-size:12px;font-weight:500}.account-text small{font-size:10px;color:#7e8975}.canvas-header{display:flex;align-items:center;gap:12px;flex:none;height:51px;box-sizing:border-box;padding:0 20px 0 13px;border-bottom:1px solid var(--line);color:#7f887b}.breadcrumb{display:flex;align-items:center;gap:10px;font-size:12px;min-width:0;flex:1}.workspace-crumb{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:200px;color:#829078}.crumb-divider{color:#ccd2c8}.document-name{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#475340;font-weight:500}.header-right{display:flex;align-items:center;gap:18px;flex:none}.save-state{display:flex;align-items:center;gap:6px;font-size:11px;color:#7a8871}.status-dot{width:4px;height:4px;border-radius:50%;background:#c9b682}.saved .status-dot{background:#78996a}.save-button{display:flex;align-items:center;gap:6px;font-size:10px!important;color:#7b8971!important}.save-button kbd{font-family:inherit;font-size:9px;color:#b0b8a8;padding-left:5px}.icon-button{display:grid;place-items:center;width:27px;height:27px;flex:none;padding:0!important;color:#919b8a!important}.sidebar-toggle{color:#7e8b76!important}button{cursor:pointer;border:0;background:transparent;border-radius:4px;padding:6px 9px;font:inherit;color:inherit}button:hover{background:#eef1eb}button:disabled{opacity:.45;cursor:wait}button:focus-visible{outline:2px solid #7d9277;outline-offset:2px}.operation-error{padding:10px 16px;background:#fff4ee;color:#a05d4b;font-size:12px;display:flex;align-items:center;gap:8px}.operation-error span{flex:1}.sidebar-backdrop{display:none}@media(max-width:1000px){.header-right{gap:10px}.save-button kbd{display:none}.workspace-crumb{max-width:120px}}@media(max-width:760px){.workspace-sidebar{position:absolute;inset:0 auto 0 0;width:min(280px,85vw);box-shadow:8px 0 24px #0002;z-index:40}.sidebar-backdrop{display:block;position:absolute;inset:0;border:0;border-radius:0;background:#202a2345;z-index:39}.canvas-header{padding-inline:10px;height:47px;gap:8px}.workspace-crumb,.crumb-divider{display:none}.header-right{gap:6px}.save-state{max-width:90px;overflow:hidden;white-space:nowrap;font-size:9px}.save-button{padding:5px}.save-button span{display:none}.menu-popover{max-width:200px}.account-info{padding-bottom:calc(17px + env(safe-area-inset-bottom))}}
</style>
