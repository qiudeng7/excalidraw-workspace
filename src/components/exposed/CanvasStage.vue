<script setup lang="ts">
// Thin L2 export of the single-canvas editor; props come from CanvasDocumentController state.
import type { Component } from "vue";
import Inner from "~/components/ExcalidrawCanvas.client.vue";

defineOptions({ inheritAttrs: false });
const Target: Component = Inner;
</script>

<template><Target v-bind="$attrs" embedded /></template>
