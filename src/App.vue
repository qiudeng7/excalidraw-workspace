<script setup lang="ts">
import { RouterLink, RouterView, useRoute } from 'vue-router'

const route = useRoute()
</script>

<template>
  <header v-if="route.name !== 'draw'" class="app-header">
    <RouterLink class="brand" to="/home">Excalidraw Workspace</RouterLink>
    <nav aria-label="主导航">
      <RouterLink to="/home">首页</RouterLink>
      <RouterLink to="/">画布</RouterLink>
      <RouterLink to="/about">关于</RouterLink>
    </nav>
  </header>
  <main class="app-main">
    <RouterView />
  </main>
</template>
