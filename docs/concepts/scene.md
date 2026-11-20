# Scenes

A scene is the graph as flat typed arrays. Index `i` in the node arrays is one node; edges
refer to nodes by that index. The scene knows nothing about what a node means: it holds
positions, connectivity and one style byte per element. Names, attributes and anything else
you need on click or hover stay in your own structures, looked up by the same index.

## The arrays

```ts
interface Scene {
  nodeCount: number
  nodeX: Float64Array // longitude, or world x
  nodeY: Float64Array // latitude, or world y
  nodeStyle: Uint8Array // index into styles.nodes (0–31)

  edgeCount: number
  edgeFrom: Uint32Array // node index of the first end
  edgeTo: Uint32Array // node index of the second end
  edgeStyle: Uint8Array // index into styles.edges (0–31)

  // Optional: polylines instead of straight lines
  edgePathStart?: Uint32Array
  edgePathEnd?: Uint32Array
  pathX?: Float64Array
  pathY?: Float64Array

  // Optional: path points already projected (see below)
  pathUnitX?: Float64Array
  pathUnitY?: Float64Array

  // Optional: per-element overrides of the style (0 = use the style)
  nodeColor?: Uint32Array // 0xRRGGBBAA
  nodeRadius?: Float32Array
  edgeColor?: Uint32Array // 0xRRGGBBAA
  edgeWidth?: Float32Array
}
```

A style byte of 255 (`HIDDEN`) hides an element: it is not drawn, picked, labelled, queried
or clustered (see [Filters](./filters.md)). The per-element arrays are described in
[Styles](./styles.md#per-element-colours-and-sizes). To build a scene from GeoJSON or a
graphology graph, see [GeoJSON, graphs and edge shapes](../guide/interop.md).

Arrays may be longer than `nodeCount` / `edgeCount`; only the first `count` entries are
read. Edges are undirected as far as drawing goes, except for arrowheads
(`EdgeStyle.arrow`), which are drawn at the `edgeTo` end; the path runs from
`edgePathStart` to `edgePathEnd`.

Why arrays and not objects: a million `{ x, y, style }` objects cost tens of megabytes of
headers and pointers and a garbage collector that has to walk them. A million entries in a
`Float64Array` cost eight megabytes, can be copied to the GPU, a worker or WebAssembly in
one call, and are read in a tight loop without pointer chasing.

## Building a scene

`SceneBuilder` grows typed arrays as you add elements and freezes them into a scene:

```ts
import { SceneBuilder } from 'skeinmap'

const b = new SceneBuilder({ nodes: 100_000, edges: 200_000 }) // capacity hints, optional
const a = b.node(9.19, 45.46) // style 0
const c = b.node(12.49, 41.9, 1) // style 1
b.edge(a, c) // straight line, style 0
b.edge(a, c, 2, [9.19, 45.46, 11.0, 44.0, 12.49, 41.9]) // polyline, flat [x0, y0, x1, y1, …]
b.edge(a, c, 2, [
  [9.19, 45.46],
  [12.49, 41.9],
]) // or [x, y] pairs
const scene = b.build()
```

- `node(x, y, style?)` and `edge(from, to, style?, path?)` return the new index.
- Capacity hints only avoid reallocations; growing past them is fine.
- `build()` copies the arrays to their exact length. The builder can keep growing and
  build again, which is how an editor appends elements without starting over.

You can also fill the arrays yourself — decoded from a binary file, received from a worker,
or computed in WebAssembly. `validateScene(scene)` checks the invariants (lengths, node
indices in range, path ranges inside the point arrays, style bytes below 32) and returns a
list of problems; use it in development and tests. The layer itself does not validate on
every update.

Other helpers:

| Function             | Purpose                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `emptyScene()`       | A scene with no elements, a convenient initial value                     |
| `sceneBounds(scene)` | `[minX, minY, maxX, maxY]` over nodes and path points, `null` when empty |
| `isRouted(scene, e)` | Whether edge `e` is drawn along its own polyline (two or more points)    |

## Paths

An edge with a path is drawn along the points
`pathX/pathY[edgePathStart[e] .. edgePathEnd[e])` instead of the straight line between its
nodes. A range shorter than two points draws the straight line, so routed and straight
edges mix freely in one scene.

Ranges are given as a start and an end rather than one offsets array, so points need not be
stored in edge order, and a builder can reuse the same point arrays across scenes whose
edges were regrouped (for example sorted by style). The first and last points do not have
to coincide with the edge's nodes, though they usually should.

Picking and the hover outline follow the path; so do levels of detail (one point is kept
per cell a path crosses) and the Canvas 2D simplification (Douglas–Peucker per zoom). See
[Rendering](./rendering.md).

### Pre-projected paths

The layer projects every node and path point once per scene. When you rebuild scenes often
and most paths do not change, project the points yourself once and pass them as
`pathUnitX/pathUnitY`: with a Mercator adapter the layer adopts these arrays as they are
instead of projecting again.

```ts
import { mercatorUnit } from 'skeinmap'

const n = pathX.length
const pathUnitX = new Float64Array(n)
const pathUnitY = new Float64Array(n)
for (let p = 0; p < n; p++) mercatorUnit(pathX[p], pathY[p], pathUnitX, pathUnitY, p)
const scene = { ...base, pathX, pathY, pathUnitX, pathUnitY }
```

`pathX/pathY` are still required: they give the point count, and `sceneBounds`, `fitScene`
and non-Mercator adapters read them.

## Coordinates and units

Scene coordinates are `x` and `y`:

- **With a map adapter** (Leaflet, MapLibre, or the pan/zoom view with
  `projection: MERCATOR`), `x` is **longitude** and `y` is **latitude**, in degrees. This
  is GeoJSON order — not Leaflet's `[lat, lng]`.
- **With the standalone view** and its default identity projection, `x` and `y` are plain
  world units with `y` pointing down, like screen coordinates.

Internally the layer works in _units_. A projection turns scene coordinates into units once
per scene; the view then maps units to pixels with one multiply (the zoom) and one rotation:

| Projection                               | Units                                                                                                                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MERCATOR`                               | Spherical Mercator (EPSG:3857). A unit is a pixel of a 256 px world at zoom 0, the convention Leaflet uses, so the pixel position at zoom `z` is the unit position times `2^z`. Latitudes are clamped to ±85.0511° (`MAX_MERCATOR_LAT`). |
| `IDENTITY`                               | Scene coordinates are units.                                                                                                                                                                                                             |
| `{ kind: 'custom', project(x, y, out) }` | Anything else, for example another CRS. `project` writes the units of one point into `out.x` / `out.y`.                                                                                                                                  |

`mercatorUnit(lon, lat, outX, outY, i)` and `mercatorInverse(ux, uy)` convert single points
without allocating. The Mercator projection of whole scenes runs in the
[kernels](./wasm.md) (WebAssembly when loaded).

The Leaflet adapter uses `MERCATOR` for the default CRS and a custom projection through
`map.project` for any other. The MapLibre adapter always uses `MERCATOR`.

## Updating a scene

| You changed                                | Call                                         | Cost                                         |
| ------------------------------------------ | -------------------------------------------- | -------------------------------------------- |
| Style bytes (selection, filter, highlight) | `layer.restyle()`                            | Re-uploads one byte per element              |
| Coordinates, in place in the same arrays   | `layer.setScene(scene)` with the same object | Re-projects                                  |
| Elements added or removed                  | `layer.setScene(newScene)`                   | Re-projects, rebuilds GPU buffers and levels |

`setScene` always re-projects, even for the object that is already set, because
coordinates may have been rewritten in place. Both calls are coalesced onto the next
animation frame, so a `setScene` and a `restyle` in the same tick paint once. Hover state
is reset by `setScene`: indices of the old scene mean nothing in the new one.
