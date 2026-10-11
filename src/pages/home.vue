<template>
  <section class="page">
    <h1>Excalidraw Workspace</h1>
    <p>用画布整理想法，在自己的工作空间中管理多个画布与素材。</p>
    <p>
      登录后，画布和素材库会自动保存到你的账户，也可按 Ctrl / ⌘ S 主动保存。
    </p>
    <NuxtLink class="workspace-link" to="/">打开我的画布 →</NuxtLink>
  </section>
</template>

<style scoped>
.workspace-link {
  display: inline-block;
  margin-top: 12px;
  padding: 10px 18px;
  border-radius: 6px;
  background: var(--app-accent);
  color: var(--app-on-accent);
  text-decoration: none;
  font-size: 14px;
}
.workspace-link:hover {
  background: var(--app-accent-hover);
}
.workspace-link:focus-visible {
  outline: 2px solid var(--app-focus);
  outline-offset: 3px;
}
</style>
