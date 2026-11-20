# Adapters

The layer does not know whether it is drawn over a Leaflet map, a MapLibre map, a plain
`<div>` or something else. An **adapter** tells it three things: where the view is, where the
canvases go, and which pointer events happened. Everything else — projecting, caching,
drawing, picking, labels, tooltips — is the layer's job, so an adapter is short.

| Adapter                                   | Import              | Projection                                              |
| ----------------------------------------- | ------------------- | ------------------------------------------------------- |
| `createPanZoomAdapter(element, options?)` | `skeinmap`          | Identity by default, or `MERCATOR`                      |
| `leafletAdapter(L, map, options?)`        | `skeinmap/leaflet`  | `MERCATOR` for the default CRS, `map.project` otherwise |
| `maplibreAdapter(map)`                    | `skeinmap/maplibre` | `MERCATOR`                                              |

## The contract

```ts
interface MapAdapter {
  /** How scene coordinates become units. */
  readonly projection: Projection
  /** The current view. Called at least once per paint: keep it cheap. */
  getViewport(): Viewport
  /** Put the elements into the page and start delivering events. Returns the teardown. */
  attach(elements: LayerElements, events: AdapterEvents): () => void
  /** Optional: called at the start of every paint, after the canvases were sized. */
  beforePaint?(elements: LayerElements): void
  /** Where the pointer cursor is set over something clickable. */
  readonly cursorTarget: HTMLElement
}
```

`attach` receives the layer's elements — `base` (the scene canvas), `overlay` (labels and
hover) and `tooltip` (a `<div>`) — and the callbacks to invoke:

```ts
interface AdapterEvents {
  view(): void // the view moved, zoomed, rotated or resized: repaint now
  pointerMove(x: number, y: number): void // container pixels
  pointerLeave(): void
  click(x: number, y: number): boolean // true when something was picked
}
```

Rules that keep the layer in step with the host:

- Call `events.view()` **synchronously** from the host's own render or move event, not on
  a timer. The layer repaints in the same frame, so the graph never lags behind the tiles.
- The canvases are absolutely positioned at `left: 0; top: 0` and sized by the layer. Put
  them in an element that covers the view and is positioned (`position: relative` or
  similar), above the host's own drawing.
- The canvases have `pointer-events: none`; listen for pointer events on the host element
  and pass container-relative pixels.
- When `click` returns `true`, stop the event from reaching the host, so a click on a node
  does not also count as a click on the map.
- The teardown must remove every listener. The layer removes its own elements in
  `destroy()`.

## The viewport

```ts
interface Viewport {
  width: number // container size, CSS pixels
  height: number
  k: number // pixels per unit
  centerX: number // unit coordinates of the container's centre
  centerY: number
  rotation?: number // radians, clockwise (screen y points down). Default 0
  dpr?: number // backing-store pixel ratio. Default window.devicePixelRatio
  zoom: number // the host's own zoom level, passed through to callbacks such as `scale`
}
```

A position `u` in units is drawn at the container pixel

```
p = R(rotation) · k · (u − center) + (width, height) / 2
```

where `R(θ)` is the rotation matrix `[[cos θ, −sin θ], [sin θ, cos θ]]`. Every adapter's job
reduces to filling in `k`, `center` and `rotation` so that this formula matches the host.

For the Mercator projection a unit is a pixel of a 256 px world at zoom 0:

- **Leaflet** uses the same convention, so `k = 2^zoom` (`map.getZoomScale(zoom, 0)`), and
  the centre comes from the map's pixel origin.
- **MapLibre** has a 512 px world at zoom 0, so `k = 2^(zoom + 1)`. The centre is the
  container centre unprojected to longitude/latitude and projected with `mercatorUnit` —
  which also honours map padding — and `rotation = −bearing` in radians.
- **The pan/zoom view** stores `center` and `k` directly; with the identity projection a
  unit is whatever your scene coordinates are.

`zoom` is informational: the layer derives its own zoom levels from `k`. It is passed to
the `scale` function so a curve like `zoomScale(view.zoom)` can use the host's familiar
numbers.

## Writing an adapter

A complete adapter for a view driven from code — no gestures, an explicit `setView` — fits
on one screen:

```ts
import {
  createGraphLayer,
  IDENTITY,
  type AdapterEvents,
  type LayerElements,
  type MapAdapter,
  type Viewport,
} from 'skeinmap'

export interface FixedViewAdapter extends MapAdapter {
  setView(centerX: number, centerY: number, k: number, rotation?: number): void
  dispose(): void
}

export function createFixedViewAdapter(element: HTMLElement): FixedViewAdapter {
  let centerX = 0
  let centerY = 0
  let k = 1
  let rotation = 0
  let events: AdapterEvents | null = null

  if (getComputedStyle(element).position === 'static') element.style.position = 'relative'

  const local = (e: MouseEvent): [number, number] => {
    const r = element.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const onMove = (e: PointerEvent) => events?.pointerMove(...local(e))
  const onLeave = () => events?.pointerLeave()
  const onClick = (e: MouseEvent) => {
    if (events?.click(...local(e))) e.stopPropagation()
  }
  const resize = new ResizeObserver(() => events?.view())

  return {
    projection: IDENTITY,
    cursorTarget: element,
    getViewport(): Viewport {
      return {
        width: element.clientWidth,
        height: element.clientHeight,
        k,
        centerX,
        centerY,
        rotation,
        zoom: Math.log2(k),
      }
    },
    attach(elements: LayerElements, ev: AdapterEvents) {
      events = ev
      element.append(elements.base, elements.overlay, elements.tooltip)
      element.addEventListener('pointermove', onMove)
      element.addEventListener('pointerleave', onLeave)
      element.addEventListener('click', onClick)
      resize.observe(element)
      return () => {
        element.removeEventListener('pointermove', onMove)
        element.removeEventListener('pointerleave', onLeave)
        element.removeEventListener('click', onClick)
        resize.disconnect()
        events = null
      }
    },
    setView(x, y, nextK, nextRotation = 0) {
      centerX = x
      centerY = y
      k = nextK
      rotation = nextRotation
      events?.view()
    },
    dispose() {
      resize.disconnect()
    },
  }
}

// Usage
const adapter = createFixedViewAdapter(document.getElementById('graph')!)
const layer = createGraphLayer(adapter, { scene, styles, nodeTooltip: (i) => `Node ${i}` })
adapter.setView(500, 300, 2, Math.PI / 12) // centre (500, 300), 2 px per unit, rotated 15°
```

### Adapting another map library

The same skeleton hosts the graph in any map library that exposes its view:

1. `projection`: `MERCATOR` if the library uses Web Mercator; otherwise a custom projection
   that calls the library's own projection at a fixed zoom.
2. `getViewport`: compute `k` from the library's zoom and world size
   (`k = 2^zoom · worldSizeAtZoom0 / 256`), project the centre of the container with
   `mercatorUnit`, and convert the library's bearing to clockwise radians.
3. `attach`: append the canvases to the element that holds the library's canvas or tiles,
   subscribe `events.view` to its per-frame render or move event, and forward its pointer
   events with container-relative coordinates.
4. `beforePaint` (optional): if the canvases live in a layer that the library translates
   while panning (Leaflet's map panes do), re-anchor them here so they stay aligned. The
   Leaflet adapter moves them to the container's top-left corner in layer space on every
   paint.

If the library animates zooms with CSS transforms instead of repainting each frame, apply
the same transform to the canvases during the animation and repaint when it ends — the
Leaflet adapter does exactly this with Leaflet's `zoomanim` event.

## World copies

Web maps repeat the world side by side when zoomed out or panned past the antimeridian. By
default a scene is drawn once, around longitude 0. With `worldCopies: true` the layer draws
it again on every copy in view (up to nine), like the tiles:

```ts
createGraphLayer(adapter, { scene, styles, worldCopies: true })
layer.setOptions({ worldCopies: false }) // toggle at any time
```

- It applies to adapters with the Mercator projection: Leaflet with the default CRS,
  MapLibre, and the pan/zoom view with `projection: MERCATOR`. It is ignored otherwise.
- Copies are drawn from the same GPU buffers with a shifted centre (one extra pair of draw
  calls per copy on WebGL2; Canvas 2D draws the culled scene once per copy).
- Picking, hover, tooltips, labels and `queryBox` / `queryPolygon` work on every copy and
  report the original element index.
- Paths that cross the antimeridian with continuous longitudes (as `greatCirclePath`
  produces) show their far part on the neighbouring copy.

## The standalone view

`createPanZoomAdapter(element, options?)` is the adapter for a view without a map: drag
to pan, wheel or pinch to zoom, and the keyboard.

| Option               | Default              | Meaning                                                                                                     |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `projection`         | `IDENTITY`           | `MERCATOR` for longitude/latitude without a basemap                                                         |
| `center`, `k`        | `[0, 0]`, 1          | Initial view (units, pixels per unit)                                                                       |
| `minK`, `maxK`       | 1e-6, 1e6            | Zoom limits                                                                                                 |
| `wheelSpeed`         | 1.0015               | Zoom factor per pixel of wheel delta                                                                        |
| `interactive`        | `true`               | `false` for a view driven only from code                                                                    |
| `keyboard`           | `true`               | Arrow keys pan, `+` / `-` zoom, `0` calls `onReset`. The element is made focusable (`tabindex="0"`)         |
| `keyboardPanStep`    | 80                   | Pixels per arrow-key press                                                                                  |
| `onReset`            | —                    | Called for the `0` key; typically fit the scene                                                             |
| `onBoxSelect`        | —                    | Shift-drag draws a box; called on release with its corners in container pixels. Without it, shift-drag pans |
| `selectionClassName` | `skeinmap-selection` | Class of the box element                                                                                    |

```ts
let layer: GraphLayer
const adapter = createPanZoomAdapter(element, {
  projection: MERCATOR,
  onReset: () => adapter.fitBounds(bounds),
  onBoxSelect: ({ x0, y0, x1, y1 }) => select(layer.queryBox(x0, y0, x1, y1)),
})
layer = createGraphLayer(adapter, { scene, styles })
```

The adapter also has `setView(centerX, centerY, k?)`, `fitBounds(bounds, padding?)`,
`onViewChange(callback)` (after each repaint; handy for [clustering](./clustering.md)) and
`dispose()`. See [Selection](./selection.md) for what to do with the box.

## Known limits of the built-in adapters

- **Pitch and globe** are not supported by the MapLibre adapter: the graph is drawn flat in
  Web Mercator. Set `maxPitch: 0` and keep the map's Mercator projection; the adapter warns
  once if it sees a pitch.
- The Leaflet adapter supports any CRS, but only the default (EPSG:3857) is projected by the
  fast kernels; other CRSs go through `map.project` point by point, once per scene, and get
  no world copies.
