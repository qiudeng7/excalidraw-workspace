<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue'
import { createElement, useState } from 'react'
import { SamplingMenu, readSampling, saveSampling, type Sampling } from './canvasSampling'
import { RenderingOptionsMenu, readRenderingOptions, saveRenderingOptions, defaultRenderingOptions } from './canvasRenderingOptions'
import { createRoot, type Root } from 'react-dom/client'
import { Excalidraw, FONT_FAMILY, MainMenu } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

const container = useTemplateRef<HTMLDivElement>('container')
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
      createElement(MainMenu.DefaultItems.Help),
      createElement(MainMenu.DefaultItems.ClearCanvas),
      createElement(MainMenu.Separator),
      createElement(SamplingMenu, {
        value: sampling,
        onChange: (value: Sampling) => {
          setSampling(value)
          saveSampling(value)
        },
      }),
      createElement(MainMenu.Separator),
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
  })
}

onMounted(() => {
  if (!container.value) return
  root = createRoot(container.value)
  root.render(createElement(CanvasEditor))
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
  container-type: inline-size;
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

/* 移动版使用独立 DOM，留出底部菜单和撤销按钮的位置。 */
.canvas-host :deep(.excalidraw--mobile .App-top-bar .App-toolbar--mobile) {
  position: absolute;
  inset-inline: -0.5rem;
  width: auto;
  bottom: calc(3.5rem + env(safe-area-inset-bottom, 0px));
}

.canvas-host :deep(.excalidraw--mobile .App-top-bar > .HintViewer) {
  position: absolute;
  top: auto;
  bottom: calc(9rem + env(safe-area-inset-bottom, 0px));
  padding: 0;
  margin: 0;
}

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
