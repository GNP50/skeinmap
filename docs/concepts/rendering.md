# Rendering

A layer owns two canvases stacked in the adapter's container: the **base** canvas draws the
scene, with WebGL2 or Canvas 2D, and the **overlay** canvas, always Canvas 2D, draws labels
and the hover outline. A hover change repaints only the overlay.

```ts
createGraphLayer(adapter, { scene, styles, renderer: 'auto' }) // 'auto' | 'webgl' | 'canvas'
layer.backend // 'webgl' or 'canvas'
layer.stats // { backend, kernels, instances, drawn, lodZoom, frameMs }
```

`auto` (the default) and `webgl` use WebGL2 when the browser provides it and fall back to
Canvas 2D otherwise; `canvas` always uses Canvas 2D. The canvases are sized to the
container times the device pixel ratio (`Viewport.dpr`, default `window.devicePixelRatio`).

## WebGL2

The whole scene lives on the GPU. A pan or zoom changes a handful of uniforms and issues two
instanced draw calls, so the cost of a frame no longer grows with the number of elements
— only with the number of pixels they cover.

- **Nodes** are instanced quads. The fragment shader draws the disc and its stroke with
  antialiasing, matching the Canvas 2D look (stroke centred on the radius).
- **Edges** are instanced quads, one per segment; a routed edge is one instance per path
  segment. The fragment shader measures the distance to the segment, so caps are round and
  widths are exact. Dashed styles use the same 2 on / 4 off pattern as Canvas 2D.
- **Styles** are uniform arrays of 32 entries indexed by the per-element style byte. A
  restyle re-uploads the bytes, never the positions.
- **Draw order** follows the scene: all edges, then all nodes, each in index order. One
  difference from Canvas 2D: where segments of a translucent style overlap, their opacity
  accumulates.

`stats.instances` is the number of instances in the full scene: nodes plus edge segments.

### Precision

GPUs compute in 32-bit floats, which carry about seven significant digits. For a Mercator
map, units span 0–256, so float32 alone resolves about 1.5·10⁻⁵ units — several pixels at
street-level zoom, enough to make nodes jitter while panning. Positions are therefore
uploaded once per scene as two float32 values each, a high and a low part
(double-single), and the vertex shader subtracts the view centre from both parts before
combining them. Positions stay sub-pixel at any zoom a web map reaches.

### Level of detail

Far out, many elements fall on the same few pixels. Drawing them all wastes fill rate and
makes a dense graph look like a blot. Above `lod.minInstances` (default 50,000 instances),
the layer computes a reduced scene per integer zoom level (`floor(log2(k))`):

- Positions are binned into 2 px cells at that zoom.
- Per cell, one node **per style** is kept, so every category stays visible.
- A straight edge whose two ends share a cell is dropped.
- Edges joining the same two cells with the same style are drawn once.
- A routed edge keeps one point per cell it crosses.

The result is visually indistinguishable from the full scene at that zoom. Details:

- Levels are computed asynchronously (see below); the full scene is drawn until a level
  arrives, then the frame switches to it.
- A level that keeps 60% or more of the full scene is not uploaded: the full scene is drawn
  instead (`stats.lodZoom` shows which level the last frame used, `null` for the full
  scene).
- No levels past `lod.maxZoom` (default 15), and none at zooms where cell keys would lose
  precision in a double (`lodFits`).
- Elements restyled after their level was computed are drawn on top of it, so a selection
  cannot be binned away (see [Styles](./styles.md#restyle-setscene-redraw)).
- `lod: false` turns it off.

Binning is one of the [kernels](./wasm.md): WebAssembly when loaded, TypeScript otherwise.

### Computing levels in a worker

Without a worker, a level is computed inline on a later task, so the frame that needed it
does not pay for it — but the main thread still does the work, and binning a million
elements takes long enough to notice in the middle of a zoom. Hand the layer a worker
factory to move it off the main thread:

```ts
// lod.worker.ts
import { initWasm } from 'skeinmap'
import 'skeinmap/lod-worker'
void initWasm()
```

```ts
createGraphLayer(adapter, {
  scene,
  styles,
  lod: { worker: () => new Worker(new URL('./lod.worker.ts', import.meta.url), { type: 'module' }) },
})
```

The geometry is copied to the worker once per scene (transferred typed arrays); after that,
each request is a zoom level and each answer comes back as transferred index arrays. The
worker has its own module instance, so it runs WebAssembly only if it loads it itself — the
`initWasm()` in the file above, or a `{ type: 'wasm', url }` message posted right after
creating the worker. If the worker fails to load, the layer computes levels inline. See
[Bundlers and frameworks](../guide/frameworks.md#the-level-of-detail-worker).

## Canvas 2D

The fallback draws with plain canvas calls from positions in absolute pixels (units times
the view's scale and rotation), computed once per zoom: a pan only shifts the drawing
offset.

- Elements outside the viewport are culled; work below a pixel is skipped.
- Canvas state (colour, width, dash) changes once per run of equal styles. Build scenes
  grouped by style — all edges of style 0, then style 1, and so on — and a frame needs a
  handful of state changes instead of one per element.
- Polylines are simplified per zoom with Douglas–Peucker at a tolerance of half a pixel, so a
  long route drawn at country scale costs a few points rather than thousands. Disable with
  `simplify: false`. Simplification is a [kernel](./wasm.md), computed once per zoom level
  and cached.

There is no level of detail on Canvas 2D: every element in view is drawn. It handles tens of
thousands of elements comfortably; for hundreds of thousands, WebGL2 is the backend to rely
on.

## Losing the WebGL context

Browsers can take a WebGL context away (GPU reset, too many contexts, a driver update). The
layer listens for `webglcontextlost`; on the next paint it discards the WebGL renderer,
replaces the base canvas with a fresh one and continues with Canvas 2D for the rest of the
layer's life. Nothing is lost: the scene, styles, hover state and callbacks stay as they
were. To try WebGL again, create a new layer.

## Coalescing

`setScene`, `restyle`, `redraw` and `setOptions` schedule one paint on the next animation
frame, so any number of them in the same tick paint once. View changes from the adapter
repaint synchronously, so the graph moves in step with the map's own canvas or tiles.
