# Performance

## What makes it fast

**Flat arrays.** A scene is a few typed arrays, not an object per element. Building a
million-element scene writes numbers into preallocated storage; handing it to the GPU, a
worker or WebAssembly is a block copy. See [Scenes](../concepts/scene.md).

**Two coordinate levels.** Scene coordinates are projected to _units_ once per scene. On
WebGL2 the units go to the GPU once, and a pan or zoom is a few uniforms. On Canvas 2D (and
for picking and labels) units are turned into _absolute pixels_ once per zoom; a pan only
shifts the offset. Neither path re-projects on a pan.

**One draw call per kind.** WebGL2 draws every node in one instanced call and every edge
segment in another. The frame cost depends on pixels covered, not on element count.

**Level of detail.** Above 50,000 instances, the WebGL backend draws a per-zoom reduction that
looks the same at that zoom: one node per style per 2 px cell, duplicate edges merged.
Zoomed out over a large scene, a frame draws a fraction of the instances. See
[Rendering](../concepts/rendering.md#level-of-detail).

**Restyle is a byte write.** A selection or a theme switch re-uploads one byte per element
and a 32-entry table. No geometry moves.

**Picking through a grid.** Hover and click query a few grid cells around the pointer. The
grid is in absolute pixels, so it survives panning. See
[Picking](../concepts/picking.md#how-a-pick-works).

**Coalesced work.** Scene changes, restyles and option changes in the same tick share one
paint. Hover picks once per animation frame. The hover outline repaints the overlay only.

**WebAssembly for the loops that scale with the scene.** Projection, level-of-detail
binning, grid builds, polyline simplification and clustering run in Rust compiled to WebAssembly once it
has loaded, and can run in a worker. See [WebAssembly kernels](../concepts/wasm.md).

## Getting the most out of it

- **Use WebGL2** for anything beyond tens of thousands of elements. Check `layer.backend`;
  `renderer: 'canvas'` is for environments where WebGL is unavailable or unwanted.
- **Call `initWasm()` early**, without awaiting it, and with Vite add
  `optimizeDeps.exclude: ['skeinmap']` so it actually loads in development. Check
  `wasmStatus()` / `layer.stats.kernels`.
- **Move level-of-detail computation to a worker** for scenes in the hundreds of thousands,
  so zooming into a new level never stalls the main thread. See
  [Computing levels in a worker](../concepts/rendering.md#computing-levels-in-a-worker).
- **Restyle instead of rebuilding.** Write style bytes in place and call `restyle()`;
  reserve `setScene` for geometry changes.
- **Hide with a filter instead of rebuilding.** `setFilter` costs a pass over the style
  bytes; a new scene costs projection, GPU upload and levels. See [Filters](../concepts/filters.md).
- **Per-element arrays are not free on the GPU.** Each of `nodeColor`, `nodeRadius`,
  `edgeColor`, `edgeWidth` adds 4 bytes per element; changing them re-uploads them with the
  style bytes, which is cheap but not nothing at a million elements.
- **Group by style** when building the scene, especially for Canvas 2D: state changes happen
  once per run of equal styles.
- **Pre-project paths** (`pathUnitX/pathUnitY`) when you rebuild scenes often and most
  polylines do not change.
- **Keep callbacks cheap.** `nodeTooltip`, `nodeLabel` and `labelPriority` are called per
  hover change or per labelled node per frame; look values up, do not compute them.
- **Mind labels on very large scenes.** Finding label candidates is a pass over every node
  per overlay paint. Return `null` from `nodeLabel` for nodes that will never be named, use
  priority `0` for filler, or toggle `labels` off.
- **Watch `layer.stats`.** `instances`, `drawn`, `lodZoom` and `frameMs` (CPU time of the
  last paint) tell you what the last frame did.

## Running the benchmarks

The benchmarks compare the TypeScript and WebAssembly kernels on seeded synthetic graphs of
10k, 100k and 1M nodes (with as many edges, and polyline paths), against the built package
in `dist/` — what users get.

```sh
npm run build
npm run bench
# or a subset, with a longer time per case:
node bench/run.mjs --sizes 10000,100000 --time 3000
```

Results are printed and written to `bench/results/results.json` and
`bench/results/results.md`. Numbers depend heavily on the machine, the JavaScript engine and
whether the run is warm; compare runs on the same machine.

The [demo](../demo.md) shows the rendering side live: frame time, instances drawn and the
level of detail in use, at up to a million elements, with either kernel set.

## Results

Measured 2026-11-14 on Intel(R) Xeon(R) Processor @ 2.10GHz (4 threads), linux x64, Node v22.23.4. Median of up to 30 runs, milliseconds; lower is better.

| Case                                   |      Size | TypeScript | WebAssembly | Speed-up |
| -------------------------------------- | --------: | ---------: | ----------: | -------: |
| SceneBuilder (n nodes + n edges)       |    10,000 |       0.63 |           — |        — |
| SceneBuilder (n nodes + n edges)       |   100,000 |       5.44 |           — |        — |
| SceneBuilder (n nodes + n edges)       | 1,000,000 |       66.9 |           — |        — |
| project mercator (nodes)               |    10,000 |       0.31 |        0.31 |    0.99× |
| project mercator (nodes)               |   100,000 |       3.43 |        2.46 |    1.40× |
| project mercator (nodes)               | 1,000,000 |       34.0 |        26.8 |    1.27× |
| LOD level z4                           |    10,000 |       2.24 |        0.79 |    2.82× |
| LOD level z4                           |   100,000 |       23.2 |        7.32 |    3.17× |
| LOD level z4                           | 1,000,000 |      327.9 |       157.0 |    2.09× |
| LOD level z8                           |    10,000 |       1.66 |        0.60 |    2.75× |
| LOD level z8                           |   100,000 |       22.8 |        7.91 |    2.88× |
| LOD level z8                           | 1,000,000 |      364.4 |       225.4 |    1.62× |
| LOD setup (copy geometry)              |    10,000 |       0.00 |        0.02 |        — |
| LOD setup (copy geometry)              |   100,000 |       0.00 |        0.46 |        — |
| LOD setup (copy geometry)              | 1,000,000 |       0.00 |        8.39 |        — |
| grid build (picking index)             |    10,000 |       1.33 |        0.98 |    1.36× |
| grid build (picking index)             |   100,000 |       12.9 |        9.37 |    1.37× |
| grid build (picking index)             | 1,000,000 |      154.9 |       117.5 |    1.32× |
| Douglas–Peucker (paths)                |    10,000 |       0.40 |        0.35 |    1.13× |
| Douglas–Peucker (paths)                |   100,000 |       3.85 |        4.06 |    0.95× |
| Douglas–Peucker (paths)                | 1,000,000 |       38.8 |        44.4 |    0.87× |
| Douglas–Peucker (persistent, per zoom) |    10,000 |       0.34 |        0.36 |    0.95× |
| Douglas–Peucker (persistent, per zoom) |   100,000 |       3.76 |        3.77 |    1.00× |
| Douglas–Peucker (persistent, per zoom) | 1,000,000 |       43.3 |        38.9 |    1.11× |
| Douglas–Peucker setup (persistent)     |    10,000 |       0.00 |        0.11 |        — |
| Douglas–Peucker setup (persistent)     |   100,000 |       0.00 |        0.66 |        — |
| Douglas–Peucker setup (persistent)     | 1,000,000 |       0.00 |        8.94 |        — |
| cluster level z6 ¹                     | 1,000,000 |       39.3 |        15.1 |    2.60× |
| cluster setup (copy positions) ¹       | 1,000,000 |       0.00 |        1.37 |        — |

¹ Measured later, at 1M only, with `node bench/run.mjs --sizes 1000000 --time 800` on the same
shared machine; compare these two rows with each other rather than with the rest of the table.

Setup rows are one-time costs per scene (WebAssembly copies the geometry into its own memory; the TypeScript kernels keep references). Drawing is not measured here.
