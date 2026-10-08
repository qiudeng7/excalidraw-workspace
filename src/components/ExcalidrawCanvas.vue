<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import { createElement, Fragment, useState } from 'react'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import { SamplingMenu, readSampling, saveSampling, type Sampling } from './canvasSampling'
import { RenderingOptionsMenu, readRenderingOptions, saveRenderingOptions, defaultRenderingOptions } from './canvasRenderingOptions'
import { createRoot, type Root } from 'react-dom/client'
import { Excalidraw, FONT_FAMILY, MainMenu, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawProps, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import type { CanvasDocument, CanvasScene, LibraryDocument } from '../../shared/contracts'
import { PersistentResource } from '../lib/persistence'

const props = defineProps<{ document: CanvasDocument; library: LibraryDocument; userId: string }>()
const emit = defineEmits<{ 'save-state': [status: string] }>()
const message = ref('')
const loading = ref(true)
const hasConflict = ref(false)
const otherDrafts = ref<{ key: string; label: string; filename: string; data: unknown }[]>([])
const selectedOtherDraft = ref('')
function downloadOtherDraft() {
  const draft = otherDrafts.value.find(item => item.key === selectedOtherDraft.value)
  if (!draft) return
  downloadJson(draft.filename, draft.data)
}
function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
let active = false
let sceneFingerprint = ''
let libraryFingerprint = ''
function stateChanged(error?: string) {
  hasConflict.value = sceneResource.conflict || libraryResource.conflict
  if (error) message.value = error
  else if (!sceneResource.dirty && !libraryResource.dirty) message.value = ''
  emit('save-state', error ? '保存异常' : sceneResource.dirty || libraryResource.dirty ? '待保存…' : '已保存')
}
const sceneResource = new PersistentResource<CanvasScene>(
  `${props.userId}:canvas:${props.document.id}`, `/api/canvases/${props.document.id}`, 'scene',
  props.document.scene, props.document.revision, stateChanged,
)
const libraryResource = new PersistentResource<unknown[]>(
  `${props.userId}:library`, '/api/library', 'items', props.library.items, props.library.revision, stateChanged,
)
async function flush() {
  await Promise.all([sceneResource.flush(), libraryResource.flush()])
}
async function retry() { try { await flush() } catch { /* The resource displays the failure. */ } }
async function loadCloudVersion() {
  if (!window.confirm('请先下载本地备份。继续将丢弃发生冲突的本地草稿，重新加载云端内容。确定继续？')) return
  try {
    // Keep a non-conflicting resource's pending draft intact across the reload.
    if (sceneResource.conflict) await sceneResource.discardDraft()
    if (libraryResource.conflict) await libraryResource.discardDraft()
    window.location.reload()
  } catch { message.value = '无法清理本地草稿，请保留备份后重试。' }
}
function downloadBackup() {
  const scene = sceneResource.value
  const blobs = [
    { name: `${props.document.name}.excalidraw`, data: { type: 'excalidraw', version: 2, source: location.origin, ...scene } },
    { name: '素材库.excalidrawlib', data: { type: 'excalidrawlib', version: 2, source: location.origin, libraryItems: libraryResource.value } },
  ]
  for (const file of blobs) {
    downloadJson(file.name, file.data)
  }
}
const snapshot: NonNullable<ExcalidrawProps['onChange']> = (elements, appState, files) => {
  if (!active) return
  // Upstream's export filter removes transient selections/collaborators and keeps referenced images.
  const serialized = serializeAsJSON(elements, appState, files, 'local')
  const fingerprint = serialized
  if (fingerprint === sceneFingerprint) return
  sceneFingerprint = fingerprint
  const data = JSON.parse(serialized) as CanvasScene
  sceneResource.update({ elements: data.elements, appState: data.appState, files: data.files })
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (sceneResource.dirty || libraryResource.dirty) { event.preventDefault(); event.returnValue = '' }
}
onBeforeRouteLeave(async () => {
  try { await flush(); return true } catch { return false }
})
defineExpose({ flush })

const container = useTemplateRef<HTMLDivElement>('container')
const router = useRouter()
let root: Root | undefined

function CanvasEditor() {
  const [sampling, setSampling] = useState<Sampling>(readSampling)
  const [renderingOptions, setRenderingOptions] = useState(readRenderingOptions)
  return createElement(Excalidraw, {
    canvasSampling: sampling,
    canvasRenderingOptions: renderingOptions,
    langCode: 'zh-CN',
    theme: 'light',
    children: createElement(
      MainMenu,
      null,
      createElement(MainMenu.DefaultItems.LoadScene),
      createElement(MainMenu.DefaultItems.SaveToActiveFile),
      createElement(MainMenu.DefaultItems.Export),
      createElement(MainMenu.DefaultItems.SaveAsImage),
      createElement(MainMenu.DefaultItems.SearchMenu),
      createElement(MainMenu.DefaultItems.CommandPalette),
      createElement(MainMenu.DefaultItems.Help),
      createElement(MainMenu.DefaultItems.ClearCanvas),
      createElement(MainMenu.Separator),
      createElement(MainMenu.DefaultItems.ToggleTheme),
      createElement(MainMenu.DefaultItems.ChangeCanvasBackground),
      createElement(MainMenu.Group, {
        title: '跳转',
        className: 'canvas-menu-group',
        children: createElement(Fragment, null,
          createElement(MainMenu.ItemCustom, {
            className: 'canvas-navigation-hint',
            children: '画布和素材库会自动保存，跳转前会等待保存完成。',
          }),
          createElement(MainMenu.Item, {
            children: '首页',
            onSelect: () => { void router.push('/home') },
          }),
          createElement(MainMenu.Item, {
            children: '关于',
            onSelect: () => { void router.push('/about') },
          }),
        ),
      }),
      createElement(MainMenu.Group, {
        title: 'debug',
        className: 'canvas-menu-group',
        children: createElement(Fragment, null,
          createElement(SamplingMenu, {
            value: sampling,
            onChange: (value: Sampling) => {
              setSampling(value)
              saveSampling(value)
            },
          }),
          createElement(RenderingOptionsMenu, {
            value: renderingOptions,
            onChange: (value) => {
              setRenderingOptions(value)
              saveRenderingOptions(value)
            },
            onReset: () => {
              setSampling(1)
              saveSampling(1)
              setRenderingOptions({ ...defaultRenderingOptions })
              saveRenderingOptions(defaultRenderingOptions)
            },
          }),
        ),
      }),
    ),
    initialData: {
      ...sceneResource.value,
      appState: {
        currentItemFontFamily: FONT_FAMILY.Nunito,
        currentItemRoughness: 0,
        currentItemStrokeStyle: 'solid',
        currentItemFillStyle: 'solid',
        currentItemStrokeWidthKey: 'medium',
        ...sceneResource.value.appState,
      },
      libraryItems: libraryResource.value,
    } as ExcalidrawInitialDataState,
    onInitialize: (editor) => {
      sceneFingerprint = serializeAsJSON(editor.getSceneElements(), editor.getAppState(), editor.getFiles(), 'local')
      libraryFingerprint = JSON.stringify(libraryResource.value)
      active = true
      if (sceneResource.dirty) sceneResource.schedule()
      if (libraryResource.dirty) libraryResource.schedule()
      stateChanged(sceneResource.conflict || libraryResource.conflict ? message.value : undefined)
    },
    onChange: snapshot,
    onLibraryChange: (items) => {
      if (!active) return
      const fingerprint = JSON.stringify(items)
      if (fingerprint === libraryFingerprint) return
      libraryFingerprint = fingerprint
      libraryResource.update([...items])
    },
  })
}

onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload)
  await Promise.all([sceneResource.restore(), libraryResource.restore()])
  try {
    const [scenes, libraries] = await Promise.all([sceneResource.findOtherDrafts(), libraryResource.findOtherDrafts()])
    otherDrafts.value = [
      ...scenes.map((draft, index) => ({ key: draft.key, label: `画布草稿 ${index + 1} · ${draft.updatedAt ? new Date(draft.updatedAt).toLocaleString() : '较早版本'}`, filename: `${props.document.name}-草稿.excalidraw`, data: { type: 'excalidraw', version: 2, source: location.origin, ...draft.value } })),
      ...libraries.map((draft, index) => ({ key: draft.key, label: `素材库草稿 ${index + 1} · ${draft.updatedAt ? new Date(draft.updatedAt).toLocaleString() : '较早版本'}`, filename: '素材库-草稿.excalidrawlib', data: { type: 'excalidrawlib', version: 2, source: location.origin, libraryItems: draft.value } })),
    ]
    selectedOtherDraft.value = otherDrafts.value[0]?.key ?? ''
  } catch { /* restore already reports unavailable local storage. */ }
  if (!container.value) return
  loading.value = false
  root = createRoot(container.value)
  root.render(createElement(CanvasEditor))
})

onBeforeUnmount(() => {
  active = false
  window.removeEventListener('beforeunload', beforeUnload)
  sceneResource.dispose()
  libraryResource.dispose()
  root?.unmount()
  root = undefined
})
</script>

<template>
  <div class="canvas-editor-shell">
    <div v-if="loading" class="save-notice">正在加载画布与本地草稿…</div>
    <div v-if="message" class="save-notice" role="alert">
      <span>{{ message }}</span>
      <button type="button" @click="retry">重试保存</button>
      <button type="button" @click="downloadBackup">下载本地备份</button>
      <button v-if="hasConflict" type="button" @click="loadCloudVersion">加载云端版本</button>
    </div>
    <div v-if="otherDrafts.length" class="save-notice">
      <span>发现其他页面或之前会话的本地草稿，可下载后通过画布菜单或素材库导入恢复。</span>
      <select v-model="selectedOtherDraft" aria-label="其他本地草稿">
        <option v-for="draft in otherDrafts" :key="draft.key" :value="draft.key">{{ draft.label }}</option>
      </select>
      <button type="button" @click="downloadOtherDraft">下载所选草稿</button>
    </div>
    <div ref="container" class="canvas-host" />
  </div>
</template>

<style scoped>
.canvas-editor-shell { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.save-notice { padding: 8px 12px; background: #fff4da; color: #634600; font-size: 13px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.save-notice button { border: 1px solid #d2bd8d; background: white; border-radius: 4px; padding: 4px 8px; cursor: pointer; }

.canvas-host {
  flex: 1;
  min-height: 0;
  width: 100%;
  height: 100%;
  container-type: inline-size;
}

.canvas-host :deep(.canvas-menu-group > .dropdown-menu-group-title) {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1rem 0 0.5rem;
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--color-gray-60);
}

.canvas-host :deep(.canvas-menu-group > .dropdown-menu-group-title)::before,
.canvas-host :deep(.canvas-menu-group > .dropdown-menu-group-title)::after {
  content: '';
  height: 1px;
  flex: 1;
  background: var(--default-border-color);
}

.canvas-host :deep(.canvas-navigation-hint) {
  max-width: 15rem;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-gray-60);
}

/* 菜单较长，窄屏也沿用容器滚动，预留上下操作区。 */
.canvas-host :deep(.dropdown-menu .dropdown-menu-container) {
  max-height: calc(100dvh - 150px);
  overflow-y: auto;
}

/* 工具栏以画布内部的 FixedSideContainer 为定位边界。 */
.canvas-host :deep(.App-menu_top) {
  grid-template-columns: 1fr 1fr;
}

.canvas-host :deep(.App-menu_top > .shapes-section) {
  position: absolute;
  inset-inline: 0;
  bottom: env(safe-area-inset-bottom, 0px);
  justify-self: stretch;
}

.canvas-host :deep(.App-toolbar .HintViewer) {
  top: auto;
  bottom: 100%;
  margin-top: 0;
  margin-bottom: 0.5rem;
}

/* 更多工具随工具栏向上展开，避免超出画布。 */
.canvas-host :deep(.App-toolbar__extra-tools-dropdown) {
  top: auto;
  bottom: calc(100% + 0.375rem);
  margin-top: 0;
}

/* 新版移动工具栏原生位于 App-bottom-bar，无需额外定位。 */

@container (max-width: 960px) {
  .canvas-host :deep(.App-menu_top > .shapes-section) {
    bottom: calc(3.5rem + env(safe-area-inset-bottom, 0px));
  }

  .canvas-host :deep(.shapes-section > div) {
    max-width: 100%;
  }

  .canvas-host :deep(.App-toolbar > .Stack_horizontal) {
    flex-wrap: wrap;
    justify-content: center;
  }
}
</style>
