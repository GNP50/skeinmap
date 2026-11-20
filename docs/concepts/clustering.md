# Clustering

Levels of detail keep the look of a dense scene while drawing less of it. Clustering
changes what is shown: at a given zoom, every occupied screen cell becomes **one node** at
the centroid of its members, and edges are merged between clusters. Use it when the
individual nodes are not meaningful from far away and a count is more useful than a blot.

```ts
import { createClusterIndex } from 'skeinmap'

const index = createClusterIndex(scene) // longitude/latitude, 60 px cells
const { scene: clustered, counts, members } = index.level(6)
layer.setScene(clustered)
```

## The index

`createClusterIndex(scene, options?)` reads the scene once (node positions are projected
when the index is created) and computes levels on demand.

| Option       | Default      | Meaning                                                                                                                                   |
| ------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `projection` | `'mercator'` | `'mercator'` for longitude/latitude, `'identity'` for scene coordinates that are already units (the standalone view without a projection) |
| `cellPx`     | 60           | Cell width in pixels at the level's zoom                                                                                                  |

`index.level(zoom)` returns the clusters at `zoom`, where one unit is `2^zoom` pixels — the
same convention as the layer's levels of detail. Levels are cached (up to 32 zooms), so
going back to a zoom costs nothing. `index.dispose()` drops the cache and the memory held
by the WebAssembly kernels. Create a new index for a new scene.

What a level contains (`ClusterView`):

| Field        | Meaning                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scene`      | A new scene: one node per cluster at its centroid, `nodeStyle` 0 for a single node and 1 for a cluster of several; one edge per pair of clusters joined by at least one visible edge (style 0, straight) |
| `counts`     | Members per cluster                                                                                                                                                                                      |
| `clusterOf`  | Cluster of each original node, `NO_CLUSTER` (`0xFFFFFFFF`) for a hidden one                                                                                                                              |
| `members(c)` | The original node indices of cluster `c`, ascending. A view into shared storage: do not modify it                                                                                                        |

The cluster scene is an ordinary scene: rewrite its style bytes, give it per-node radii or
colours, and pass it to `setScene`.

## Which zoom

The index counts zoom like Leaflet: a unit is a pixel of a 256 px world at zoom 0. For any
adapter, the right integer zoom comes from the viewport:

```ts
const zoom = Math.floor(Math.log2(adapter.getViewport().k))
```

That is `map.getZoom()` (floored) for Leaflet, `map.getZoom() + 1` for MapLibre (its world is
512 px at zoom 0), and `log2(k)` for the pan/zoom view with `projection: MERCATOR`.

## Swapping scenes on zoom

Recompute when the integer zoom changes, and swap the scene:

```ts
import { createClusterIndex, createGraphLayer, type ClusterView } from 'skeinmap'

const index = createClusterIndex(scene)
let current: { zoom: number; view: ClusterView } | null = null

const layer = createGraphLayer(adapter, {
  scene: index.level(zoomOf()).scene,
  styles,
  // Callbacks look at the current level, so they never need to be replaced.
  nodeLabel: (c) => (current && current.view.counts[c] > 1 ? String(current.view.counts[c]) : null),
  labelPriority: (c) => (current ? Math.log2(current.view.counts[c] + 1) : 1),
  nodeTooltip: (c) => (current ? `${current.view.counts[c]} nodes` : null),
  onNodeClick: (c) => zoomInto(current!.view.members(c)),
})

function zoomOf() {
  return Math.floor(Math.log2(adapter.getViewport().k))
}

function update() {
  const zoom = zoomOf()
  if (current?.zoom === zoom) return
  const view = index.level(zoom)
  // Size clusters by member count; 0 keeps the style's radius for single nodes.
  view.scene.nodeRadius ??= Float32Array.from(view.counts, (n) => (n > 1 ? 4 + 2 * Math.log2(n) : 0))
  current = { zoom, view }
  layer.setScene(view.scene)
}

map.on('zoomend', update) // Leaflet or MapLibre; for the pan/zoom view: adapter.onViewChange(update)
update()
```

Notes:

- `setScene` re-projects the cluster scene, which is small; the cost is the clustering
  itself, once per zoom, and then nothing on the way back.
- For a click on a cluster, `members(c)` gives the original nodes: fit the view to their
  bounds, list them, or select them in the full scene.
- Use clusters and the full scene together by switching at a zoom threshold: clusters
  below it, `setScene(scene)` above it.

## Clusters and filters

Nodes with style `HIDDEN` (255) join no cluster, and edges with style 255 or touching a
hidden node are left out of the aggregated edges. The index reads the scene's own style
bytes, not the layer's [filter](./filters.md): to cluster only what a filter shows, give
the index a copy whose `nodeStyle` carries the filter.

```ts
import { HIDDEN } from 'skeinmap'

const nodeStyle = Uint8Array.from(scene.nodeStyle)
for (let i = 0; i < nodeStyle.length; i++) if (!visible[i]) nodeStyle[i] = HIDDEN
const index = createClusterIndex({ ...scene, nodeStyle })
```

A filter is per scene: call `layer.setFilter(null)` before swapping in a cluster scene, since
its node indices are cluster ids.

## Kernels and determinism

Clustering runs on the active [kernels](./wasm.md) (`clusterLevel`, `createClusterer`):
WebAssembly once loaded, TypeScript otherwise. Both produce the same clusters — same ids,
same members, same centroids — and the test suite checks it. The index projects positions
with the TypeScript Mercator projection whatever kernels are active, so that the clusters
never depend on when WebAssembly finished loading.

Cluster ids follow the first appearance of their cell in node order, so a level is stable
for a given scene. A node with a non-finite position forms a cluster of its own.

Measured with `npm run bench` (1M nodes, zoom 6): see
[Performance](../guide/performance.md#results).
