<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Excalidraw, FONT_FAMILY, MainMenu } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

const container = useTemplateRef<HTMLDivElement>('container')
let root: Root | undefined

onMounted(() => {
  if (!container.value) return
  root = createRoot(container.value)
  root.render(
    createElement(Excalidraw, {
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
        createElement(MainMenu.DefaultItems.Help),
        createElement(MainMenu.DefaultItems.ClearCanvas),
        createElement(MainMenu.Separator),
        createElement(MainMenu.DefaultItems.ToggleTheme),
        createElement(MainMenu.DefaultItems.ChangeCanvasBackground),
      ),
      initialData: {
        appState: {
          currentItemFontFamily: FONT_FAMILY.Nunito,
          currentItemRoughness: 0,
          currentItemStrokeStyle: 'solid',
          currentItemFillStyle: 'solid',
          currentItemStrokeWidth: 2,
        },
      },
    }),
  )
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
