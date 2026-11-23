<script setup lang="ts">
// Thin L2 export; props and events pass straight through to the in-app component.
import type { Component } from "vue";
import Inner from "~/components/CanvasTabs.vue";

defineOptions({ inheritAttrs: false });
const Target: Component = Inner;
</script>

<template><Target v-bind="$attrs" /></template>
