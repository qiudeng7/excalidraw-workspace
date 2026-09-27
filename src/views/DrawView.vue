<script setup lang="ts">
import ExcalidrawCanvas from '../components/ExcalidrawCanvas.vue'
</script>

<template>
  <section class="draw-page" aria-label="Excalidraw 画布">
    <p class="draw-hint">画布不会自动保存，离开页面前请通过左上角菜单保存到文件。</p>
    <div class="draw-editor">
      <ExcalidrawCanvas />
    </div>
  </section>
</template>

<style scoped>
.draw-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.draw-hint {
  margin: 0;
  padding: 8px 16px;
  font-size: 13px;
  line-height: 1.5;
  color: #686878;
  background: #f7f7fa;
}
.draw-editor {
  flex: 1;
  min-height: 0;
}
</style>
