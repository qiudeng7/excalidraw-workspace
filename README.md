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
