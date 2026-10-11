<script setup lang="ts">
const route = useRoute();
</script>

<template>
  <header v-if="route.path !== '/'" class="app-header">
    <NuxtLink class="brand" to="/home">Excalidraw Workspace</NuxtLink>
    <nav aria-label="主导航">
      <NuxtLink to="/home">首页</NuxtLink>
      <NuxtLink to="/">画布</NuxtLink>
      <NuxtLink to="/about">关于</NuxtLink>
      <ThemeSwitcher />
    </nav>
  </header>
  <main class="app-main">
    <NuxtPage />
  </main>
</template>
