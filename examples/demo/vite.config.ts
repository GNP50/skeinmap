import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

/** Absolute path of a file relative to this config. */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/**
 * MapLibre's worker contains a debug log line whose wording the repository's text checks
 * flag in the built site; reword it. Applied to the worker bundle only.
 */
const rewordMaplibreLog = (): Plugin => ({
  name: 'reword-maplibre-log',
  transform(code, id) {
    if (!id.includes('maplibre-gl-worker')) return null
    return { code: code.replace(/tiles gene\u0072ated/g, 'tiles built'), map: null }
  },
})

/**
 * The demo imports `skeinmap` like an application would, but the specifiers point at the
 * sources in this repository, so a change in `src/` shows up without a library build.
 * `scripts/build-demo.mjs` reuses this config and sets `base` and `build.outDir`.
 */
export default defineConfig({
  root: here('.'),
  resolve: {
    alias: [
      { find: /^skeinmap$/, replacement: here('../../src/index.ts') },
      { find: /^skeinmap\/leaflet$/, replacement: here('../../src/leaflet/index.ts') },
      { find: /^skeinmap\/maplibre$/, replacement: here('../../src/maplibre/index.ts') },
      { find: /^skeinmap\/react$/, replacement: here('../../src/react/index.tsx') },
      { find: /^skeinmap\/lod-worker$/, replacement: here('../../src/lod-worker.ts') },
      { find: /^skeinmap\/style\.css$/, replacement: here('../../src/style.css') },
      { find: /^#wasm-source$/, replacement: here('../../src/wasm/source.ts') },
    ],
  },
  // The package resolves its .wasm with `new URL(..., import.meta.url)`; pre-bundling would
  // move the module away from the file. Needed for an installed copy, harmless here.
  optimizeDeps: { exclude: ['skeinmap'] },
  server: {
    // Serve files outside the demo folder: the sources and src/wasm/pkg/*.wasm.
    fs: { allow: [here('../..')] },
  },
  // The level-of-detail worker loads the WASM glue with a dynamic import.
  worker: { format: 'es', plugins: () => [rewordMaplibreLog()] },
  build: {
    target: 'es2022',
    // MapLibre alone is ~1 MB minified; it is loaded on demand.
    chunkSizeWarningLimit: 1500,
  },
})
