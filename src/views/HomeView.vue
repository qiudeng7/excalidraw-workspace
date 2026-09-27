<script setup lang="ts">
import { useCounterStore } from '../stores/counter'

const counter = useCounterStore()
</script>

<template>
  <section class="page">
    <h1>Vue Demo</h1>
    <p>Vue + Vite + TypeScript + Pinia + Vue Router</p>
    <button class="demo-button" @click="counter.increment">计数：{{ counter.count }}</button>
    <p>切换页面后，计数会保留；刷新页面后重置。</p>
  </section>
</template>
