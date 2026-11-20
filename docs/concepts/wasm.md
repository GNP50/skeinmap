# WebAssembly kernels

Five hot paths — the loops whose cost grows with the size of the scene — have two
implementations: a Rust crate compiled to WebAssembly, and pure TypeScript. They produce the
same output for the same input, so which one runs is a speed decision only.

| Kernel                              | Used for                                                  | When it runs                                         |
| ----------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| `projectMercator`                   | Longitude/latitude to Mercator units                      | Once per scene (`setScene`)                          |
| `createLod` → `level(zoom)`         | [Level-of-detail](./rendering.md#level-of-detail) binning | Once per scene and zoom level, WebGL only            |
| `createGridBuilder` → `build()`     | The [picking grid](./picking.md#how-a-pick-works)         | When the zoom or scene changes and the pointer moves |
| `simplifyPaths`, `createSimplifier` | Douglas–Peucker on polylines                              | Once per scene and zoom level, Canvas 2D only        |
| `clusterLevel`, `createClusterer`   | [Grid clustering](./clustering.md) (`createClusterIndex`) | Once per scene and zoom level, when you cluster      |

Everything else — drawing, picking queries, labels, the adapters — is TypeScript. The WASM
binary is small (a few tens of kilobytes) because it holds nothing but these loops.

## Loading

```ts
import { initWasm } from 'skeinmap'

void initWasm() // optional; not awaited
```

Nothing waits for it. Layers start on the TypeScript kernels; when the module is ready, every
layer is notified, drops what the kernels built (grid, levels, simplification) and rebuilds it
with WebAssembly on demand. The projection of the current scene is kept until the next
`setScene`.

`initWasm(source?, options?)`:

- Resolves `true` once the WebAssembly kernels are active, `false` when they could not be
  loaded. It never rejects unless you pass `{ throwOnError: true }`.
- Concurrent calls share one load. After a failure, a later call tries again.
- With no `source`, the ESM build resolves `skeinmap_wasm_bg.wasm` next to its own module
  with `new URL(..., import.meta.url)`, which bundlers turn into an emitted asset. The
  CommonJS build reads the file from disk under Node. See
  [Bundlers and frameworks](../guide/frameworks.md).
- `source` may be a URL or string, a `Response` or a promise of one (`fetch(...)`), an
  `ArrayBuffer`, a typed array of the bytes, or a compiled `WebAssembly.Module`. A `file:`
  URL is read with `node:fs` under Node.

State, for diagnostics or a status line:

| Function              | Returns                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| `wasmStatus()`        | `'idle'`, `'loading'`, `'ready'` or `'failed'`                               |
| `wasmError()`         | Why the last load failed (the thrown value), if it did                       |
| `kernels()`           | The active kernel set; `kernels().name` is `'wasm'` or `'ts'`                |
| `layer.stats.kernels` | Which kernels the layer used for its last projection, grid or simplification |

## Choosing explicitly

```ts
import { setKernelPreference, getKernelPreference, onKernelsChange } from 'skeinmap'

setKernelPreference('ts') // always TypeScript, even when WASM is loaded
setKernelPreference('wasm') // WASM when loaded (TypeScript until then)
setKernelPreference('auto') // the default: same as 'wasm'

const off = onKernelsChange(() => console.log('now using', kernels().name))
```

The preference takes effect at the next kernel call; layers subscribe to `onKernelsChange`
and rebuild their grid, levels and simplification. Call `layer.setScene(layer.scene)` to
re-run the projection too — the demo does this so its timings reflect the selected kernels.

The preference is per module instance. A [level-of-detail worker](./rendering.md#computing-levels-in-a-worker)
has its own and loads its own WebAssembly.

## Why the output is the same

The Rust crate mirrors the TypeScript kernels operation for operation: the same formulas in
the same order, in the same `f64` arithmetic, with the same traversal orders wherever the
order of the output is observable (hash tables are used for lookups only; which slot a key
lands in never affects the result).

The test suite runs both implementations on the same seeded inputs, from empty scenes to
tens of thousands of elements, plus edge cases such as degenerate windows and points on the
rounding edge of a grid cell, and compares:

- **integer outputs exactly** — the nodes and segments kept by a level of detail, the rows
  of a picking grid, the keep mask of a simplification, the cluster of each node and the
  member counts;
- **cluster centroids bit for bit** — both sides sum member positions in node order;
- **Mercator projections to within 10⁻⁹ units** — the two sides call different `sin` and
  `log` implementations, which may differ in the last bit. A unit is a pixel at zoom 0, so
  this is far below a pixel at any zoom a map reaches.

That has two consequences worth knowing:

- Switching implementations does not change what is drawn or picked.
- A change to one implementation must be made to the other. See
  [Contributing](../guide/contributing.md#keeping-the-kernels-in-step).

## The TypeScript kernels directly

`tsKernels` is the TypeScript set, and `kernels()` returns the active one. Both implement the
`Kernels` interface, so you can use them outside a layer — for example to compute levels of
detail or a picking grid in a test or a Node script. The types are exported: `Kernels`,
`LodGeometry`, `LodLevel`, `LodComputer`, `GridTopology`, `GridPositions`, `GridWindow`,
`GridData`, `GridBuilder`, `Simplifier`, `ClusterLevel`, `Clusterer`, plus `lodFits`,
`MAX_EDGE_CELLS`, `DEFAULT_CLUSTER_CELL_PX` and `NO_CLUSTER`. The level-of-detail and
clustering kernels skip elements whose style byte is `HIDDEN` (255): a level never keeps
them, and clustering assigns them no cluster. `SceneGrid` wraps a `GridData` with the queries the layer
uses.

Objects created by the WebAssembly kernels (`createLod`, `createGridBuilder`,
`createSimplifier`, `createClusterer`) hold memory on the WASM side: call their `dispose()`
when done. A finalizer frees them if you forget, but not promptly.

## Content Security Policy

Compiling WebAssembly requires `'wasm-unsafe-eval'` in `script-src` — never `'unsafe-eval'`.
Without it, `initWasm()` resolves `false` and the TypeScript kernels keep running. See
[Content Security Policy](../guide/csp.md).
