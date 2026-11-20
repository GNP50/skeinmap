# Selection

Clicks pick one element (see [Picking](./picking.md)). For many at once, the layer answers
geometric queries in container pixels:

```ts
layer.queryBox(x0, y0, x1, y1) // Uint32Array of node indices, corners in any order
layer.queryPolygon([[x, y], …]) // nodes inside a polygon (a lasso), even–odd rule
```

Both return the indices of **visible nodes whose centre** lies inside, in ascending order:
nodes hidden by a [filter](./filters.md) or with style `HIDDEN` are never returned, and a
node whose disc only overlaps the edge of the box is not included. With
[world copies](./adapters.md#world-copies) on, a node is found in whichever copy lies in
the box. Edges are not queried.

A query is one pass over the node positions at the current zoom (already cached for
picking). Running it once per gesture is cheap; for a live preview on every pointer move
over a very large scene, throttle it to one query per animation frame.

## Showing the selection

A selection is a style-byte write, like any highlight:

```ts
const SELECTED = 3 // an entry of styles.nodes
let previous: [number, number][] = []

function showSelection(indices: Uint32Array) {
  for (const [i, style] of previous) scene.nodeStyle[i] = style
  previous = Array.from(indices, (i) => [i, scene.nodeStyle[i]])
  for (const i of indices) scene.nodeStyle[i] = SELECTED
  layer.restyle()
}
```

If the scene has per-node colours (`nodeColor`), set the selected entries to `0` while they
are selected, or the per-node colour wins over the style's fill (see
[Styles](./styles.md#per-element-colours-and-sizes)).

## Shift-drag box in the standalone view

The pan/zoom adapter draws a selection box when `onBoxSelect` is given: shift-drag draws
it, and on release the callback receives its corners in container pixels, ready for
`queryBox`. Without `onBoxSelect`, shift-drag pans like a plain drag.

```ts
import { createGraphLayer, createPanZoomAdapter } from 'skeinmap'

let layer: GraphLayer
const adapter = createPanZoomAdapter(element, {
  onBoxSelect: ({ x0, y0, x1, y1 }) => showSelection(layer.queryBox(x0, y0, x1, y1)),
})
layer = createGraphLayer(adapter, { scene, styles })
```

The box is a `<div>` with the class `skeinmap-selection` (change it with
`selectionClassName`). `skeinmap/style.css` gives it a border and a translucent fill, with
the custom properties `--skeinmap-selection-border` and `--skeinmap-selection-bg`.

## A lasso with pointer events

On a map, or for free-form shapes, collect the pointer path yourself and pass it to
`queryPolygon`. This lasso draws on its own canvas over the map while the Alt key is held,
and leaves every other gesture to the map:

```ts
function enableLasso(container: HTMLElement, onSelect: (indices: Uint32Array) => void) {
  const canvas = document.createElement('canvas')
  Object.assign(canvas.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '1500' })
  container.appendChild(canvas)
  const ctx = canvas.getContext('2d')!
  let points: [number, number][] | null = null

  const local = (e: PointerEvent): [number, number] => {
    const r = container.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const draw = () => {
    canvas.width = container.clientWidth
    canvas.height = container.clientHeight
    if (!points || points.length < 2) return
    ctx.beginPath()
    ctx.moveTo(...points[0])
    for (const p of points) ctx.lineTo(...p)
    ctx.closePath()
    ctx.fillStyle = 'rgba(37, 99, 235, 0.12)'
    ctx.strokeStyle = '#2563eb'
    ctx.fill()
    ctx.stroke()
  }

  // Capture phase: the lasso sees the press before the map starts a pan.
  container.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.altKey || e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()
      container.setPointerCapture(e.pointerId)
      points = [local(e)]
    },
    true,
  )
  container.addEventListener(
    'pointermove',
    (e) => {
      if (!points) return
      e.stopPropagation()
      points.push(local(e))
      draw()
    },
    true,
  )
  container.addEventListener(
    'pointerup',
    (e) => {
      if (!points) return
      e.stopPropagation()
      const polygon = points
      points = null
      draw()
      if (polygon.length >= 3) onSelect(layer.queryPolygon(polygon))
    },
    true,
  )
}

enableLasso(map.getContainer(), showSelection)
```

Put the listeners on the map's container (or an element around it) in the capture phase,
so the press reaches the lasso before the map's own drag handling. Leaflet also listens to
`mousedown`; `preventDefault()` on the `pointerdown` suppresses that compatibility event.
For a box rather than a lasso on a map, the same pattern with two corners and `queryBox`
works; the [demo](../demo.md) does this for shift-drag on Leaflet and MapLibre, with the
maps' own box zoom (`boxZoom: false`) turned off.

`pointInPolygon(x, y, points)` is exported as well, for testing your own points against the
same polygon with the same rule.
