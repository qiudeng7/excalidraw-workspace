<script setup lang="ts">
import { onBeforeRouteLeave } from "vue-router";
import { ref } from "vue";
import WorkspaceApp from "~/components/exposed/WorkspaceApp.vue";

const app = ref<InstanceType<typeof WorkspaceApp>>();

onBeforeRouteLeave(async () => (await app.value?.flush()) ?? true);
</script>

<template><WorkspaceApp ref="app" mode="full" /></template>
