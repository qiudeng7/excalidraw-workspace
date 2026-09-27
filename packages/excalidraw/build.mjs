import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, context } from 'esbuild'
import { sassPlugin } from 'esbuild-sass-plugin'

const packageDir = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))
const watch = process.argv.includes('--watch')
if (!watch) await rm(path.join(packageDir, 'dist'), { recursive: true, force: true })

// 保留上游的双产物结构；内部源码统一打包，第三方依赖由 pnpm 管理。
for (const mode of ['development', 'production']) {
  const production = mode === 'production'
  const options = {
    absWorkingDir: packageDir,
    entryPoints: ['index.tsx', '**/*.chunk.ts'],
    entryNames: '[name]',
    outdir: `dist/${production ? 'prod' : 'dev'}`,
    bundle: true,
    splitting: true,
    format: 'esm',
    packages: 'external',
    plugins: [sassPlugin()],
    target: 'es2020',
    assetNames: '[dir]/[name]',
    chunkNames: '[dir]/[name]-[hash]',
    alias: {
      '@excalidraw/excalidraw': packageDir,
      '@excalidraw/utils': path.resolve(packageDir, './lib/utils'),
      '@excalidraw/math': path.resolve(packageDir, './lib/math'),
    },
    loader: { '.woff2': 'file' },
    minify: production,
    sourcemap: !production,
    define: {
      'import.meta.env': JSON.stringify({
        DEV: !production,
        PROD: production,
        MODE: mode,
        PKG_NAME: pkg.name,
        PKG_VERSION: pkg.version,
        VITE_APP_ENABLE_TRACKING: 'false',
        VITE_APP_DEBUG_ENABLE_TEXT_CONTAINER_BOUNDING_BOX: 'false',
        VITE_APP_LIBRARY_URL: 'https://libraries.excalidraw.com',
        VITE_APP_LIBRARY_BACKEND: 'https://us-central1-excalidraw-room-persistence.cloudfunctions.net/libraries',
      }),
    },
  }
  if (watch) {
    await (await context(options)).watch()
  } else {
    await build(options)
  }
  console.log(`Excalidraw ${mode}: ${watch ? 'watching' : 'built'}`)
}
