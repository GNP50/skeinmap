# Styles and themes

Every node and edge carries one byte, `nodeStyle[i]` or `edgeStyle[e]`, that indexes into a
small table. The table says how each kind of element looks; the bytes say which kind each
element is. Changing how a selection looks is therefore a byte write plus a repaint, and
switching theme is a new table — neither touches geometry.

## The table

```ts
import type { SceneStyles } from 'skeinmap'

const styles: SceneStyles = {
  nodes: [
    { radius: 3, fill: '#0e7490' }, // 0: ordinary
    { radius: 6, fill: '#c2410c', stroke: '#ffffff', strokeWidth: 1.5 }, // 1: hub
    { radius: 8, fill: '#db2777', stroke: '#ffffff', strokeWidth: 2 }, // 2: selected
  ],
  edges: [
    { color: '#64748b', width: 1, opacity: 0.6 }, // 0: ordinary
    { color: '#c2410c', width: 2.5 }, // 1: important
    { color: '#64748b', width: 1, dashed: true }, // 2: planned
    { color: '#db2777', width: 3 }, // 3: selected
  ],
}
```

| Node style              | Meaning                                 |
| ----------------------- | --------------------------------------- |
| `radius`                | Disc radius in CSS pixels               |
| `fill`                  | Any CSS colour                          |
| `stroke`, `strokeWidth` | Optional outline, centred on the radius |

| Edge style | Meaning                                                      |
| ---------- | ------------------------------------------------------------ |
| `color`    | Any CSS colour                                               |
| `width`    | Line width in CSS pixels; caps are round                     |
| `opacity`  | 0–1, multiplied into the colour's own alpha. Default 1       |
| `dashed`   | A 2 px on, 4 px off pattern                                  |
| `arrow`    | Arrowhead length in CSS pixels at the `to` end. Default none |

There are at most **32** entries of each (`MAX_STYLES`): the WebGL backend keeps the table
in uniform arrays of 32. A byte with no entry in the table is drawn with
`FALLBACK_NODE_STYLE` / `FALLBACK_EDGE_STYLE` (grey). If you need more distinct looks than
that, the usual answer is that the graph needs fewer: 32 is plenty for categories plus
selected, hovered and dimmed variants.

Colours are parsed once and cached (`parseCssColor`). `#rgb`, `#rrggbb`, the alpha variants
and `rgb()` / `rgba()` are parsed directly; anything else — `hsl()`, named colours,
`color(...)` — goes through the browser's own parser on a 2D canvas.

### Arrows

An edge style with `arrow` draws a filled arrowhead at the edge's `to` end, its tip on the
rim of the target node's disc, in the edge's colour. The length is in CSS pixels and is
multiplied by `scale` like widths; the base is a little under half the length on each side.
A routed edge's arrowhead follows the direction of its last path segment, so it points along
a curve. An edge too short on screen to carry its arrowhead (shorter than 1.5 × the length
plus the node radius) is drawn without one.

```ts
const styles: SceneStyles = {
  nodes: [{ radius: 4, fill: '#0e7490' }],
  edges: [{ color: '#475569', width: 1.5, arrow: 9 }], // directed
}
```

Arrowheads are drawn for every edge of an arrowed style, also when a
[level of detail](./rendering.md#level-of-detail) reduces the edges themselves, so keep
arrows to styles with a moderate number of edges.

## Per-element colours and sizes

The style byte covers categories. For a continuous value — colour by degree, size by
population, width by traffic — a scene can carry optional per-element arrays that override
the style for that element:

| Array        | Type                        | Overrides                                         | `0` means                          |
| ------------ | --------------------------- | ------------------------------------------------- | ---------------------------------- |
| `nodeColor`  | `Uint32Array`, `0xRRGGBBAA` | the style's `fill` (the stroke stays the style's) | use the style's fill               |
| `nodeRadius` | `Float32Array`, CSS pixels  | the style's `radius`                              | use the style's radius             |
| `edgeColor`  | `Uint32Array`, `0xRRGGBBAA` | the style's `color` and `opacity`                 | use the style's colour and opacity |
| `edgeWidth`  | `Float32Array`, CSS pixels  | the style's `width`                               | use the style's width              |

Any colour with alpha 0 counts as "no override". Two helpers build packed colours:
`rgba(r, g, b, a?)` from 0–255 channels and a 0–1 alpha, and `packColor(css)` from any CSS
colour string.

```ts
import { packColor, rgba } from 'skeinmap'

const ramp = [rgba(148, 163, 184), rgba(56, 189, 248), rgba(34, 197, 94), rgba(239, 68, 68)]
scene.nodeColor = Uint32Array.from(degree, (d) => ramp[Math.min(3, d)])
scene.nodeRadius = Float32Array.from(population, (p) => 2 + Math.sqrt(p) / 50)
scene.edgeColor = new Uint32Array(scene.edgeCount)
scene.edgeColor[42] = packColor('hsl(330 80% 55%)')
layer.restyle()
```

Assign the arrays (or rewrite them in place) and call `restyle()`: they travel with the
style bytes, not the geometry. Set an array to `undefined` to drop it. Radii and widths are
still multiplied by `scale`; picking, the hover outline and label placement use the
per-node radius.

Things to know:

- **An override beats a highlight.** A node with its own colour keeps it when its style byte
  changes to "selected". Set its entry to `0` while it is highlighted (and restore it after)
  if the selection style should show.
- **Levels of detail merge by style, not by colour.** A level keeps one node per 2 px cell
  _and style_; two nodes of the same style but different colours or radii that fall into the
  same cell at that zoom are drawn as one, with the colour and radius of the representative
  the level kept. At the zoom where this happens they cover the same couple of pixels, but a
  rare colour can disappear from a dense area when zoomed far out. If a value must stay
  visible at every zoom, give it its own style byte, which a level always keeps.
- The arrays cost 4 bytes per element each, on the CPU and on the GPU.

## Scale

Radii and widths are multiplied by the layer's `scale` option: a number, or a function of
the [viewport](./adapters.md#the-viewport). `zoomScale` is a ready-made curve that keeps a
dense graph legible when zoomed out — full size from zoom 8 up, shrinking linearly to half
size at zoom 3 and below:

```ts
import { zoomScale } from 'skeinmap'

createGraphLayer(adapter, { scene, styles, scale: (view) => zoomScale(view.zoom) })
// or with your own curve:
createGraphLayer(adapter, { scene, styles, scale: (view) => zoomScale(view.zoom, { min: 0.4, low: 4, full: 10 }) })
```

## Restyle, setScene, redraw

| Call                      | When                                                                       | What it does                                                            |
| ------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `layer.restyle(styles?)`  | You wrote style bytes, or the table changed (theme)                        | Re-reads the table and the bytes. Geometry untouched                    |
| `layer.setScene(scene)`   | Positions or elements changed                                              | Re-projects and rebuilds everything derived from geometry               |
| `layer.redraw()`          | Something only the paint reads changed (scale function result, label text) | Repaints                                                                |
| `layer.setOptions({...})` | Callbacks, labels on/off, hit radius, …                                    | Applies at once; `styles` or `lod` in the patch also restyle or rebuild |

All of them are coalesced onto the next animation frame. View changes (pan, zoom, resize)
repaint synchronously, in step with the map.

A selection, in full:

```ts
const SELECTED = 2
let previous: { index: number; style: number } | null = null

function select(index: number) {
  if (previous) scene.nodeStyle[previous.index] = previous.style
  previous = { index, style: scene.nodeStyle[index] }
  scene.nodeStyle[index] = SELECTED
  layer.restyle()
}

createGraphLayer(adapter, { scene, styles, onNodeClick: select })
```

On the WebGL backend with [levels of detail](./rendering.md#level-of-detail), elements
restyled since the levels were computed are drawn on top of the level, so a selected
element is never binned away at a low zoom. When more than 5% of the elements change style
at once, the levels are recomputed instead.

## Themes

Canvases cannot resolve `var(--x)`: the table must contain resolved colours. Three helpers
cover what most applications need.

- `cssVar(name, fallback?, element?)` returns the computed value of a custom property.
  Bare HSL channel triplets (`210 40% 50%`, a common design-token format) are wrapped into
  `hsl(...)`.
- `observeTheme(callback, options?)` calls back when an attribute on the root element
  changes (`class`, `data-theme` or `style` by default) or the OS colour scheme flips.
  It returns the unsubscribe.
- `memoByTheme(resolve, key?)` memoises a value on a cheap key — by default the root's
  `class` and `data-theme` — so resolving a dozen custom properties happens once per theme,
  not once per restyle.

Pass the table as a function; the layer calls it again on every `restyle()`:

```ts
import { createGraphLayer, cssVar, memoByTheme, observeTheme } from 'skeinmap'

const styles = memoByTheme(() => ({
  nodes: [{ radius: 3, fill: cssVar('--graph-node', '#0e7490') }],
  edges: [{ color: cssVar('--graph-edge', '#64748b'), width: 1 }],
}))

const layer = createGraphLayer(adapter, {
  scene,
  styles,
  overlayColors: () => ({ text: cssVar('--fg', '#111'), halo: cssVar('--bg', '#fff') }),
})
const stopObserving = observeTheme(() => layer.restyle())
```

`overlayColors` (label text, label halo, hover accent) also accepts a function and is read
on every overlay paint. If your theme follows `prefers-color-scheme` without changing an
attribute, pass a `key` to `memoByTheme` that includes
`matchMedia('(prefers-color-scheme: dark)').matches`.

The tooltip is a DOM element styled by `skeinmap/style.css`; its colours are the custom
properties `--skeinmap-tooltip-fg`, `--skeinmap-tooltip-bg` and
`--skeinmap-tooltip-border`.
