<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

const container = useTemplateRef<HTMLDivElement>('container')
let root: Root | undefined

onMounted(() => {
  if (!container.value) return
  root = createRoot(container.value)
  root.render(createElement(Excalidraw, { langCode: 'zh-CN', theme: 'light' }))
})

onBeforeUnmount(() => {
  root?.unmount()
  root = undefined
})
</script>

<template>
  <div ref="container" class="canvas-host" />
</template>

<style scoped>
.canvas-host {
  width: 100%;
  height: 100%;
}
</style>
