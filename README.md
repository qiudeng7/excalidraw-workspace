# Vue Demo

A Vue 3 + Vite + TypeScript demo with Pinia and Vue Router. The home page has a counter that survives navigation to the About page and resets on refresh.

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
