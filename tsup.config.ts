import { resolve } from 'node:path'
import { defineConfig, type Options } from 'tsup'

/** `#wasm-source` resolves to a per-format module: a bundler-friendly URL for ESM, a
 *  file read for CommonJS under Node. */
const wasmSource = (file: string) => ({
  name: 'wasm-source',
  setup(build: { onResolve(o: { filter: RegExp }, cb: () => { path: string }): void }) {
    build.onResolve({ filter: /^#wasm-source$/ }, () => ({ path: resolve(file) }))
  },
})

const common: Options = {
  entry: {
    index: 'src/index.ts',
    leaflet: 'src/leaflet/index.ts',
    maplibre: 'src/maplibre/index.ts',
    react: 'src/react/index.tsx',
    'lod-worker': 'src/lod-worker.ts',
  },
  dts: true,
  sourcemap: true,
  clean: false,
  target: 'es2022',
  platform: 'neutral',
  external: ['leaflet', 'maplibre-gl', 'react', 'react/jsx-runtime'],
  treeshake: true,
}

export default defineConfig([
  { ...common, format: ['esm'], splitting: true, esbuildPlugins: [wasmSource('src/wasm/source.ts')] },
  { ...common, format: ['cjs'], splitting: false, esbuildPlugins: [wasmSource('src/wasm/source.cjs.ts')] },
])
