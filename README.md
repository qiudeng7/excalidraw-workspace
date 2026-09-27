# Vue Demo

A Vue 3 + Vite + TypeScript demo with Pinia, Vue Router, and an embedded Excalidraw editor. The home page has a counter that survives navigation to the About page and resets on refresh.

Use Node.js 22.12+ (or 24+) and pnpm 11. From the project directory:

```sh
pnpm install
pnpm dev
```

Open the local URL printed by Vite (normally http://localhost:5173).

```sh
pnpm build   # Type-check and build into dist/
pnpm preview # Serve the production build locally
```

Routes are in `src/router/index.ts`, pages in `src/views/`, and the counter store in `src/stores/counter.ts`. A production host must serve `index.html` for client-side routes such as `/about`.

Open **画布** in the navigation (or `/draw`) to draw shapes, text, and freehand strokes. Use the editor menu to save to a file and reopen it. The canvas is not automatically persisted: navigating away or refreshing clears it. Excalidraw uses its default CDN for fonts, which requires network access.

The Vue wrapper is `src/components/ExcalidrawCanvas.vue`; it mounts the React editor and unmounts it when leaving the page.

New shapes use clean solid strokes (`roughness: 0`, width 2), solid fills when a fill color is chosen, and Nunito text. Existing imported elements keep their styles.

The open arrowhead is customized from length 25 / half-angle 20° to length 14 / half-angle 28°. This is a version-specific pnpm patch for Excalidraw 0.18.1, applied automatically by `pnpm install`; keep the patch files and `pnpm-workspace.yaml` together with the lockfile. The patch covers development and production rendering, including exports. Opening an `.excalidraw` file in an unmodified editor uses that editor's arrowhead appearance.

Direct dependencies were checked against stable releases on 2026-09-27. React and its types stay on 18 because some Excalidraw transitive peers exclude React 19. TypeScript stays on 6.0.3 because the current `vue-tsc` 3.3.11 fails with TypeScript 7.0.2 (`ERR_PACKAGE_PATH_NOT_EXPORTED`). Recheck these compatibility constraints when upgrading.
