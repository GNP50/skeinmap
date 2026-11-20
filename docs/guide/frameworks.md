# Bundlers and frameworks

skeinmap is plain ES modules plus one asset, the `.wasm` binary. The ESM build finds
that binary with

```ts
new URL('./skeinmap_wasm_bg.wasm', import.meta.url)
```

written literally, which is the pattern Vite, webpack 5, Next.js, Parcel and Rollup (with a
URL plugin) recognise: they copy the file into your build output and rewrite the URL. If
the URL does not resolve, nothing breaks — `initWasm()` resolves `false` and the TypeScript
kernels keep running — but you lose the speed-up. See
[WebAssembly kernels](../concepts/wasm.md).

## Vite

Production builds work out of the box. In development, Vite pre-bundles dependencies into
`node_modules/.vite/deps/`, which moves the module away from the `.wasm` file next to it.
Exclude the package from pre-bundling:

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: { exclude: ['skeinmap'] },
})
```

Without this, `initWasm()` resolves `false` in `vite dev` (check `wasmError()`), and the
layer runs on the TypeScript kernels.

## webpack 5

webpack 5 handles `new URL(..., import.meta.url)` natively and emits the `.wasm` as an
asset. No configuration is needed. The binary is fetched and instantiated by the package's
own glue code rather than imported as a WebAssembly module, so
`experiments.asyncWebAssembly` is not required.

## Next.js

Next.js emits the asset the same way. The layer needs a DOM, so
create it on the client:

```tsx
'use client'
import { useEffect, useRef } from 'react'
import { createGraphLayer, createPanZoomAdapter, initWasm, type Scene } from 'skeinmap'

export function Graph({ scene }: { scene: Scene }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void initWasm()
    const adapter = createPanZoomAdapter(host.current!)
    const layer = createGraphLayer(adapter, { scene, styles })
    return () => {
      layer.destroy()
      adapter.dispose()
    }
  }, [scene])
  return <div ref={host} style={{ height: 600 }} />
}
```

Leaflet reads `window` when it is imported, so load it inside the effect
(`const L = (await import('leaflet')).default`) or render the map component with
`next/dynamic` and `ssr: false`. Treat MapLibre the same way.

## Server-side rendering

Every entry point is safe to import on the server: nothing touches `window`, `document` or
the canvas at import time, and the Leaflet and MapLibre entries only import types (you pass
the library in, or the map). What needs a browser:

- `createGraphLayer` throws `createGraphLayer needs a DOM` without one. Call it from an
  effect, `onMounted`, `onMount`, or another client-only hook.
- `useGraphLayer` and `<GraphCanvas>` only create the layer in effects, so they render an
  empty `<div>` on the server and fill it on hydration.
- `cssVar`, `observeTheme` and `memoByTheme` return their fallbacks (or do nothing) outside
  a browser.

## CommonJS and Node

The CommonJS build (`require('skeinmap')`) has no `import.meta.url`. Under Node it reads
`skeinmap_wasm_bg.wasm` from its own directory, so `await initWasm()` works without
arguments. The ESM build under Node does the same through a `file:` URL.

Anywhere else — a browser bundle that was built from the CommonJS entry, an unusual
loader, a CDN — pass the binary yourself:

```ts
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { initWasm } from 'skeinmap'

const require = createRequire(import.meta.url)
await initWasm(await readFile(require.resolve('skeinmap/wasm')))
```

`initWasm` accepts a URL or string, a `Response` (or a promise of one), an `ArrayBuffer`,
a typed array or an already compiled `WebAssembly.Module`.

What is useful in Node without a DOM: `SceneBuilder`, `validateScene`, `sceneBounds`, the
projections, `placeLabels`, and the kernels themselves (`kernels()`, `tsKernels`) — for
example to precompute or test.

## The level-of-detail worker

The layer computes levels of detail on the main thread unless you give it a worker. The
most portable way is a two-line worker file of your own, which every bundler above knows
how to build:

```ts
// lod.worker.ts
import { initWasm } from 'skeinmap'
import 'skeinmap/lod-worker'

void initWasm() // the worker has its own copy of the kernels; omit to use TypeScript there
```

```ts
createGraphLayer(adapter, {
  scene,
  styles,
  lod: { worker: () => new Worker(new URL('./lod.worker.ts', import.meta.url), { type: 'module' }) },
})
```

With Vite, set `worker: { format: 'es' }` in the config: the WASM glue is loaded with a
dynamic import, which the default `iife` worker format cannot split. If the worker fails to
load (a CSP `worker-src` that forbids it, a bundler that did not emit it), the layer notices
and computes levels on the main thread.

## MapLibre GL 6 workers

Not a skeinmap matter, but it comes up in the same configuration file: MapLibre GL 6
locates its own worker next to its module at run time, which bundlers do not see. If the
map stays blank with "Worker failed to load", hand MapLibre the URL explicitly. With Vite:

```ts
import * as maplibregl from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'

maplibregl.setWorkerUrl(workerUrl)
```

## Stylesheet

`skeinmap/style.css` styles the tooltip (`.skeinmap-tooltip`) and the card produced by
`tooltipCard` (`.skeinmap-card-*`). It is optional and every colour is a custom property
with a fallback (`--skeinmap-tooltip-fg`, `--skeinmap-tooltip-bg`,
`--skeinmap-tooltip-border`), so a theme can override them without rewriting rules. The
package marks `*.css` as having side effects, so bundlers keep the import.
