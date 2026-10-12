<script setup lang="ts">
const route = useRoute();
</script>

<template><SharedCanvasPage :canvas-id="String(route.params.id)" /></template>
