# Filters

A filter shows part of a scene without rebuilding it. Hidden elements are not drawn,
picked, labelled, queried or kept by a level of detail; the geometry on the GPU, the
projection and the picking grid stay as they are.

```ts
import { createGraphLayer } from 'skeinmap'

const layer = createGraphLayer(adapter, { scene, styles })

// 1 = visible, 0 = hidden, one byte per node
const visible = new Uint8Array(scene.nodeCount)
for (let i = 0; i < scene.nodeCount; i++) visible[i] = population[i] > 10_000 ? 1 : 0

layer.setFilter({ nodes: visible }) // edges with a hidden end are hidden too
layer.setFilter(null) // show everything again
```

## The filter object

```ts
interface LayerFilter {
  nodes?: Uint8Array | null // 1 visible, 0 hidden, one per node; absent: all visible
  edges?: Uint8Array | null // 1 visible, 0 hidden, one per edge; absent: all visible
  hideDanglingEdges?: boolean // also hide edges with a hidden end. Default true
}
```

- A node mask alone hides those nodes and, by default, every edge touching one of them.
  Pass `hideDanglingEdges: false` to keep such edges drawn.
- An edge mask alone hides edges and leaves every node visible.
- Both together combine: an edge is hidden when its own byte is 0 or (by default) when one
  of its ends is hidden.
- A filter with neither mask is the same as `null`.

The masks are read when `setFilter` is called. If you change a mask in place, call
`setFilter` again with it.

## How it works: the `HIDDEN` style byte

Style bytes 0–31 index the style table. The byte **255**, exported as `HIDDEN`, means "not
there": an element with it is skipped by drawing, picking, labels, `queryBox` /
`queryPolygon`, levels of detail and clustering.

`setFilter` does not touch your scene. The layer keeps its own copy of the style bytes,
writes `HIDDEN` into the filtered positions and draws that copy, so `layer.scene` and your
arrays keep their real styles. Cost: one pass over the elements and a style upload, the
same as `restyle()`.

You can also write `HIDDEN` into your own style bytes and call `restyle()`. That is useful
when the scene itself should carry the state (it survives `setScene`, it is exported, it is
what `createClusterIndex` sees). Use the filter when the state belongs to the view — a
search box, a toggle, a time slider — and should not leak into the data.

```ts
import { HIDDEN } from 'skeinmap'

scene.edgeStyle[e] = HIDDEN
layer.restyle()
```

## Filters and the rest of the layer

- **Restyle.** Style bytes you write while a filter is active are picked up by the next
  `restyle()`; the filter is reapplied on top.
- **setScene.** The filter stays active and is applied to the new scene. Masks are indexed
  like the scene they were made for, so set a new filter (or `null`) when the element
  indices change.
- **Hover.** A filter change clears the hover state; a hidden element cannot stay
  outlined.
- **Levels of detail.** On WebGL2 a filter change recomputes the levels of the current
  scene, because a hidden node must not represent its cell. Until the new level arrives the
  full scene is drawn (with the filter applied), so there is no frame where hidden elements
  show. For a filter that changes on every keystroke over a very large scene, debounce it.
- **Clustering.** `createClusterIndex` reads the scene's own style bytes, not the layer's
  filter. To cluster only visible nodes, give it a copy of the scene whose `nodeStyle` has
  `HIDDEN` where the filter hides (see [Clustering](./clustering.md#clusters-and-filters)).

The [demo](../demo.md) has a "Hide minor nodes" toggle that filters on a degree mask.
