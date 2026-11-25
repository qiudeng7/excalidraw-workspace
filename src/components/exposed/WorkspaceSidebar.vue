<script setup lang="ts">
// L2 resource tree for one workspace; owns its directory controller, no global store.
import { computed, toRef, watch } from "vue";
import SidebarResourceTree from "../SidebarResourceTree.vue";
import { useDirectoryTree } from "~/composables/use-directory-tree";
import "../../assets/workspace-tokens.css";

const props = defineProps<{
  workspaceId: string;
  ownerId: string;
  currentId?: string;
  locked?: boolean;
}>();
const emit = defineEmits<{
  "open-canvas": [id: string];
  "canvas-renamed": [id: string, name: string];
  "canvases-removed": [ids: string[]];
}>();
const tree = useDirectoryTree({
  workspaceId: toRef(props, "workspaceId"),
  owner: () => props.ownerId,
  locked: computed(() => !!props.locked),
  flush: async () => {},
  remember: () => {},
  open: async (canvas) => emit("open-canvas", canvas.id),
  renamed: (id, name) => emit("canvas-renamed", id, name),
  removed: (ids) => emit("canvases-removed", ids),
  knownCanvasIds: () => [],
});

watch(
  () => [props.workspaceId, props.ownerId],
  () => {
    if (props.workspaceId && props.ownerId)
      void tree.attempt(() => tree.load(null));
  },
  { immediate: true },
);
</script>

<template>
  <SidebarResourceTree
    :tree="tree"
    :workspace-id="workspaceId"
    :owner-id="ownerId"
    :current-id="currentId"
  />
</template>
