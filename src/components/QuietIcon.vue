<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{ name: string; size?: number }>(), {
  size: 18,
});
const paths: Record<string, string> = {
  panel:
    "M9 3v18M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
  plus: "M12 5v14M5 12h14",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  canvas: "M5 3h10l4 4v14H5ZM14 3v5h5M8 13h8M8 17h5",
  edit: "m15 4 5 5M4 20l1-5L16 4a2 2 0 0 1 4 4L9 19Z",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  logout: "M9 4H4v16h5M10 12h11m-4-4 4 4-4 4",
  check: "m5 12 4 4L19 6",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  close: "m6 6 12 12M6 18 18 6",
  folder: "M3 5h7l2 3h9v12H3Z",
  cloud:
    "M7 18H6a4 4 0 1 1 .5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1 0 9h-1M12 12v8m-3-3 3 3 3-3",
};
const path = computed(() => paths[props.name] ?? paths.canvas);
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="path" />
  </svg>
</template>
