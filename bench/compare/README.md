# Comparative browser benchmark

skeinmap against deck.gl, MapLibre GL JS and Leaflet (canvas renderer and Leaflet.glify),
drawing the same seeded synthetic node–link graph in Chromium, driven by Playwright.

> **Read this first.** The numbers below come from a machine with **no GPU**: WebGL runs on
> SwiftShader, a software implementation, and Canvas 2D is rasterised on the CPU. They are only
> meaningful **relative to each other, on the same machine**, and they are not a prediction of
> frame rates on a real GPU. In particular SwiftShader makes instanced draws (the technique
> skeinmap's WebGL2 backend and deck.gl both use, and the fast path on real GPUs) cost roughly
> 10 µs per instance, while it handles the plain pre-built vertex buffers MapLibre and
> Leaflet.glify upload much more cheaply. Expect the ranking of the WebGL libraries to differ on
> hardware. There are no basemap tiles anywhere (no network, and they would measure the network).

## Run it

```sh
npm run build            # at the repository root, if dist/ is missing (run.mjs does it otherwise)
cd bench/compare
npm ci
npm run bench            # ≈ 25 minutes; writes results/results.json and results/results.md
```

Playwright and a Chromium build must be resolvable with `require('playwright')`; they are not
dependencies of this folder. Options: `--sizes 100000,1000000`, `--libs skeinmap-webgl,deckgl,…`,
`--frames 120` (animation frames at 100k), `--frames-1m 20`, `--no-sync`, `--skip-build`,
`--build-only` (bundle sizes only), `--no-readme`. A full run (no `--libs`) rewrites the results
section of this file.

## What is compared

Every page is a separate Vite production build (`pages/<name>/`), takes `?n=` (elements = nodes +
edges) and exposes `window.__bench`. The shared harness (`src/harness.ts`) generates the data,
drives the camera, restyles and picks; each page only adapts it to its library.

| Page                   | Library and configuration                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `skeinmap` (WebGL2)    | The built package (`../../dist`), standalone pan/zoom adapter with the Mercator projection, `renderer: 'webgl'`, level of detail on and computed in the package's worker, WebAssembly kernels loaded before the data. The scene is the dataset's typed arrays as is (no copy). |
| `skeinmap` (Canvas 2D) | Same page with `?renderer=canvas`.                                                                                                                                                                                                                                             |
| `deckgl`               | `Deck` with a `MapView` and no basemap, `ScatterplotLayer` + `LineLayer` fed binary attributes (`Float32Array` positions, one interleaved array for the segments, `Uint8Array` colours), `pickable: true`, `antialias: false` like the other WebGL contexts.                   |
| `maplibre`             | Empty style (one background layer), two GeoJSON sources, a `circle` and a `line` layer; restyle through feature state (no re-tiling); `queryRenderedFeatures` for picking.                                                                                                     |
| `leaflet`              | `L.canvas()` renderer, one `circleMarker` per node and one `polyline` per edge; non-animated `setView` with `zoomSnap: 0`. 100k only.                                                                                                                                          |
| `glify`                | Leaflet.glify `points` (`[lat, lng]` arrays) and `lines` (GeoJSON). glify paints a line as a "brush" of offset copies, `(4·weight + 1)²` draws per frame; `weight: 0.5` (9 draws) is the closest to a 1 px line, and its lines still come out about 2 px wide.                 |

Same picture everywhere: nodes are discs of radius 3 px (`#0e7490`), edges straight 1 px lines
(`#64748b`) under the nodes, white background, 1280×800 viewport, device pixel ratio 1.

**Dataset** (`src/data.ts`): the demo's generator (`examples/demo/synthetic.ts`) without
polylines, seed 7: nodes clustered around 40 made-up cities over a 40° × 21° longitude/latitude
box, each linked to its 3 nearest neighbours in its city, plus a backbone between city hubs.
"100k" is 34,720 nodes + 65,887 edges, "1M" 347,224 nodes + 649,015 edges. Synthetic only.

## Metrics

- **First frame**: from "data ready" (the dataset in memory as typed arrays, the empty map or view
  already created) to the first frame with the data presented. It includes converting the
  arrays into what the library takes (a Scene object, binary attributes, GeoJSON, Leaflet layers),
  the library's own processing (tiling in MapLibre's workers, for example) and drawing. Data
  generation is excluded. Median over 3 page loads (2 at 1M).
- **Frame time**: a scripted camera path, zooming in by 3 levels and back out while the centre
  travels around a circle, applied with each library's own API once per animation frame
  (`setView`, `setProps({ viewState })`, `jumpTo`, Leaflet `setView`). Reported: median and 95th
  percentile of the intervals between `requestAnimationFrame` timestamps over 120 frames (20 at
  1M). Before it, a warm-up visits 9 points of the path and lets background work settle, so
  levels of detail and tiles for every zoom exist.
- **Restyle**: recolour 1% of the nodes (every 100th) and wait until the next frame with the
  change is presented; median of 6 (3 at 1M), alternating on and off. Each library's own
  path: skeinmap writes style bytes and calls `restyle()`, deck.gl gets a new colour array,
  MapLibre `setFeatureState`, Leaflet `setStyle` per marker, glify `render()`.
- **Pick**: programmatic picks at 50 node positions of the start view (5 at 1M), median of the
  per-call time, and how many found something: skeinmap `layer.pick` (8 px tolerance, the
  default; the first call builds its grid and is in `results.json` as `first`), deck.gl
  `pickObject` (radius 0, a GPU picking pass and read-back), MapLibre `queryRenderedFeatures`,
  Leaflet a synthetic `click` on the renderer's canvas (its hit test walks every layer), glify a
  Leaflet map `click` event.
- **Heap after load**: V8 heap plus ArrayBuffer backing stores (CDP `Runtime.getHeapUsage`) of
  the page's main thread after forced garbage collection, once the view has settled; in
  brackets, the growth over the same page right after data generation. Workers are not counted.
- **Bundle size**: all JavaScript Vite emitted for the page (chunks and workers, minified), raw,
  gzip -9 and brotli -11. The shared harness and data generator (about 3 KB gzip) are in every page.

**Frame sync.** Without a GPU, Chromium does not hold `requestAnimationFrame` back when the
graphics process falls behind: with no sync, every page ticks at 16.7 ms while the queue of
unfinished frames grows. So at each animation frame, and before a first frame or a restyle
counts as presented, the harness reads one pixel back from every canvas the library draws into
(`readPixels` for WebGL, `getImageData` for 2D), which waits for the commands issued so far to
execute. It is the same for every library; `--no-sync` turns it off.

**Canvas 2D and the read-back.** Chromium rasterises a 2D canvas through the GPU path
(SwiftShader here) until a page reads pixels back from it repeatedly; then it moves the canvas to
its CPU rasteriser (the console says so: "Multiple readback operations using getImageData…").
The first read-back therefore includes one rasterisation of everything on SwiftShader: for
skeinmap's Canvas 2D page at 100k the paint itself takes about 28 ms of script time and the
first `getImageData` about 3.3 s, which is most of its "first frame". Later frames of the two
Canvas 2D pages (skeinmap Canvas 2D, Leaflet) are rasterised on the CPU, which is what suits a
machine without a GPU; on GPU hardware Chromium would keep those canvases accelerated.

## Fairness notes

- Each library is configured for what we understand to be its fast path (binary attributes for
  deck.gl, feature state for MapLibre restyles, the canvas renderer for Leaflet, typed arrays as
  the scene for skeinmap). Corrections are welcome.
- skeinmap's level of detail draws a per-zoom reduction (a representative per pixel cell) when
  zoomed out, which is why it draws far fewer instances per frame than deck.gl, which draws them
  all. MapLibre's tiles also simplify geometry per zoom. deck.gl and Leaflet.glify draw everything.
- MapLibre and skeinmap do part of their work in workers (tiling; levels of detail), which the
  main-thread heap figures do not include.
- deck.gl's `pickObject` renders a picking pass, which software GL makes expensive; on a GPU it
  takes milliseconds. skeinmap and MapLibre pick on the CPU from an index.
- Leaflet's canvas renderer keeps one object per element; at 1M elements it is not run.
- skeinmap's first frame (WebGL2) draws the whole scene: levels of detail are computed after it,
  in the worker. Under software GL that full draw of ~1M instances is why its 1M first frame
  is the slowest of the table.
- skeinmap's worker is the package's own `skeinmap/lod-worker` module used as the worker entry
  (with the WebAssembly URL posted to it, as the demo does). The two-line worker file suggested
  in `docs/guide/frameworks.md` (`import 'skeinmap/lod-worker'`) is removed by Vite's production
  build because the package declares `"sideEffects": ["*.css"]`, and the worker then never answers.
- Libraries draw on their own animation frame (deck.gl, MapLibre, Leaflet's redraw) or
  synchronously inside the camera call (skeinmap), so a frame interval may include one frame of
  latency; over 120 frames this evens out.

## Results

<!-- results:start -->

Run 2026-11-14 on Intel(R) Xeon(R) Processor @ 2.10GHz (4 threads), linux x64 6.18.44-fc-v470, Node 22.23.4, Chromium 153.0.8010.12. WebGL renderer: `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` (software). Viewport 1280×800, device pixel ratio 1. Sync read-back per frame: on. Repetitions: 3 loads, 120 frames, 6 restyles, 50 picks at 100k; 2, 20, 3 and 5 at 1M. Whole run: 25 min.

| Library                                            | Elements (nodes + edges) |                                                                                                                                                                                First frame (ms) | Frame median (ms) | Frame p95 (ms) | Restyle 1% (ms) |   Pick median (ms) | Heap after load (MB) |
| -------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | ----------------: | -------------: | --------------: | -----------------: | -------------------: |
| skeinmap, WebGL2 (LOD on, worker)                  | 100k (34,720 + 65,887)   |                                                                                                                                                                                            2106 |              1033 |           1368 |             652 | < 0.1 (50/50 hits) |               4 (+2) |
| skeinmap, Canvas 2D                                | 100k (34,720 + 65,887)   |                                                                                                                                                                                            3324 |              33.4 |           66.7 |            67.7 | < 0.1 (50/50 hits) |               4 (+1) |
| deck.gl (Scatterplot + Line, binary attributes)    | 100k (34,720 + 65,887)   |                                                                                                                                                                                            2107 |              1267 |           1684 |            1640 |  1087 (50/50 hits) |               6 (+2) |
| MapLibre GL JS (GeoJSON, circle + line)            | 100k (34,720 + 65,887)   |                                                                                                                                                                                            2781 |              91.6 |            183 |             178 |  0.80 (50/50 hits) |             33 (+28) |
| Leaflet, canvas renderer (circleMarker + polyline) | 100k (34,720 + 65,887)   |                                                                                                                                                                                            1547 |               317 |            450 |             169 |  3.70 (50/50 hits) |           107 (+105) |
| Leaflet.glify (points + lines)                     | 100k (34,720 + 65,887)   |                                                                                                                                                                                             887 |               383 |            617 |             127 | < 0.1 (50/50 hits) |             83 (+80) |
| skeinmap, WebGL2 (LOD on, worker)                  | 1M (347,224 + 649,015)   |                                                                                                                                                                                           18843 |              3542 |           6070 |            1538 |    0.10 (5/5 hits) |             28 (+17) |
| skeinmap, Canvas 2D                                | 1M (347,224 + 649,015)   |                                                                                                                                                                                            7917 |               158 |            219 |             182 |    0.40 (5/5 hits) |             24 (+12) |
| deck.gl (Scatterplot + Line, binary attributes)    | 1M (347,224 + 649,015)   |                                                                                                                                                                                           15476 |             12033 |          14788 |           14585 |   10661 (5/5 hits) |             28 (+15) |
| MapLibre GL JS (GeoJSON, circle + line)            | 1M (347,224 + 649,015)   |                                                                                                                                                                                           17230 |               533 |            634 |             636 |    9.00 (5/5 hits) |           250 (+235) |
| Leaflet, canvas renderer (circleMarker + polyline) | 1M                       | not run: one Leaflet layer object per element (~1M at this size); at 100k it already needs ~0.3 s per frame and a few seconds to load, all on the main thread, so 1M is left out as impractical |                   |                |                 |                    |                      |
| Leaflet.glify (points + lines)                     | 1M (347,224 + 649,015)   |                                                                                                                                                                                            6642 |              2775 |           4868 |            1167 |    0.10 (5/5 hits) |           797 (+785) |

Bundle size of each page (all JavaScript Vite emitted for it, workers included; minified):

| Page     | JS files | JS raw (KB) | JS gzip (KB) | JS brotli (KB) | Other assets                          |
| -------- | -------: | ----------: | -----------: | -------------: | ------------------------------------- |
| skeinmap |        5 |        80.0 |         28.8 |           25.8 | WASM 51.0 KB (gzip 23.2, brotli 19.9) |
| deckgl   |        5 |       753.6 |        214.2 |          182.5 | —                                     |
| maplibre |        2 |      1547.5 |        426.2 |          349.5 | CSS 69.7 KB                           |
| leaflet  |        1 |       153.2 |         45.3 |           39.5 | CSS 14.8 KB                           |
| glify    |        1 |       266.7 |         83.8 |           72.9 | CSS 14.8 KB                           |

Times come from `performance.now()`, which this page (not cross-origin isolated) coarsens to 0.1 ms: a pick median of "< 0.1" means most calls finished within one tick.

Heap: V8 heap plus ArrayBuffer backing stores of the page’s main thread after garbage collection; in brackets, the growth over the same page with only the dataset built. Workers are not included (MapLibre keeps its tiled copy of the data in workers; skeinmap’s level-of-detail worker holds a copy of the positions).

<!-- results:end -->

### What the numbers say (run of 2026-11-14)

On this machine, without a GPU:

- **Animation.** skeinmap's Canvas 2D backend has the shortest frames at both sizes (33 ms at
  100k, 158 ms at 1M), because Canvas 2D is rasterised on the CPU here. Among the WebGL pages
  **MapLibre wins clearly** (92 ms at 100k, 533 ms at 1M): it uploads pre-built triangles,
  which SwiftShader handles well. The instanced renderers pay SwiftShader's per-instance cost:
  skeinmap WebGL2 1.0 s and deck.gl 1.3 s per frame at 100k; at 1M, 3.5 s and 12 s (skeinmap's
  level of detail draws a fraction of the instances deck.gl draws). Leaflet.glify sits between
  (0.38 s and 2.8 s), the Leaflet canvas renderer at 0.32 s at 100k.
- **First frame.** **Leaflet.glify is fastest** at both sizes (0.9 s and 6.6 s), then the Leaflet
  canvas renderer at 100k (1.5 s). skeinmap WebGL2 and deck.gl tie at 100k (2.1 s); at 1M deck.gl
  (15.5 s) and MapLibre (17.2 s) beat skeinmap WebGL2 (18.8 s), whose first frame draws every
  instance before levels of detail exist. skeinmap Canvas 2D (3.3 s, 7.9 s) is dominated by the
  first raster read-back described above.
- **Restyle of 1% of the nodes.** skeinmap Canvas 2D is fastest (68 ms, 182 ms); then glify,
  Leaflet and MapLibre at 100k (127–178 ms) and MapLibre at 1M (636 ms). skeinmap WebGL2
  (0.65 s, 1.5 s) and deck.gl (1.6 s, 14.6 s) are bound by redrawing under software GL.
- **Picking.** skeinmap and glify answer in under 0.1 ms per pick at 100k (0.1–0.4 ms at 1M),
  MapLibre in 0.8 ms (9 ms at 1M), Leaflet in 3.7 ms; deck.gl's GPU picking pass takes 1.1 s at
  100k and 10.7 s at 1M under software GL (milliseconds on a GPU).
- **Main-thread memory.** skeinmap and deck.gl add 1–2 MB over the dataset at 100k and 12–17 MB
  at 1M; MapLibre adds 28 MB and 235 MB (plus its workers, not counted), glify 80 MB and 785 MB,
  the Leaflet canvas renderer 105 MB at 100k.
- **Bundle.** skeinmap's page ships 28.8 KB of gzip JavaScript (plus a 23 KB gzip WASM module),
  Leaflet 45 KB, Leaflet.glify 84 KB (Leaflet included), deck.gl 214 KB, MapLibre 426 KB.

On a machine with a GPU the instanced renderers (skeinmap WebGL2, deck.gl) are expected to look
very different; rerun `npm run bench` there before drawing conclusions about frame rates.
