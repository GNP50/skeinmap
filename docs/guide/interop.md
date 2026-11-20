# GeoJSON, graphs and edge shapes

skeinmap draws a [scene](../concepts/scene.md) of typed arrays. These helpers turn common
formats into scenes and back, and produce edge paths for curved, parallel and great-circle
edges. None of them needs another package: the input types are small structural
interfaces, so objects typed with `@types/geojson` or a `graphology` graph are accepted as
they are.

| Function                                 | Direction                      |
| ---------------------------------------- | ------------------------------ |
| `sceneFromGeoJSON(collection, options?)` | GeoJSON → scene                |
| `sceneToGeoJSON(scene)`                  | scene → GeoJSON                |
| `sceneFromGraph(graph, options?)`        | graphology-style graph → scene |
| `curvedPath`, `parallelCurvature`        | Curved and parallel edge paths |
| `greatCirclePath`                        | Great-circle arcs on a map     |

## From GeoJSON

```ts
import { sceneFromGeoJSON } from 'skeinmap'

const collection = await (await fetch('/data/stations.geojson')).json()
const { scene, nodeFeature, edgeFeature, skipped } = sceneFromGeoJSON(collection, {
  nodeStyle: (f) => (f.properties?.kind === 'hub' ? 1 : 0),
  edgeStyle: (f) => (f.properties?.kind === 'express' ? 1 : 0),
  snap: 1e-6, // attach line ends to points within this many degrees
})

// From a pick back to the feature:
createGraphLayer(adapter, {
  scene,
  styles,
  nodeTooltip: (i) => (nodeFeature[i] >= 0 ? String(collection.features[nodeFeature[i]].properties?.name) : null),
})
```

The rules:

- Each position of a `Point` or `MultiPoint` becomes a **node**.
- Each line of a `LineString` or `MultiLineString` becomes one **edge**, drawn along the
  line: lines of more than two positions are stored as the edge's path.
- A line's first and last positions attach to the nearest existing node within `snap`
  degrees (default 0: an exact match). Points are indexed before any line is read, so a line
  attaches to a point that comes later in the collection. When no node matches, a node is
  created (style `endpointStyle`, `nodeFeature` entry -1) and indexed, so lines that meet
  at the same position share one created node. A snapped path end is moved onto its node.
- Other geometries (`Polygon`, `GeometryCollection`, …) are skipped and counted in
  `skipped`. Positions with non-finite coordinates are dropped, and a line left with fewer
  than two positions is dropped.

`nodeFeature[i]` and `edgeFeature[e]` map scene indices back to feature indices, so your
properties stay in the GeoJSON and are looked up on demand. Matching uses a hash grid, so
import stays linear in the number of features.

## To GeoJSON

```ts
import { sceneToGeoJSON } from 'skeinmap'

const collection = sceneToGeoJSON(scene)
// { type: 'FeatureCollection', features: [ Point per node, then LineString per edge ] }
```

Nodes become `Point` features with properties `{ index, style }`; edges become
`LineString` features with `{ index, from, to, style }` (`from` / `to` are node indices),
along the edge's path when it has one. Add your own properties to the features before
serialising.

The two directions round-trip: reading the export back gives the same nodes and edges, as
long as every edge path starts and ends on its nodes and no two nodes share a position.

```ts
const back = sceneFromGeoJSON(sceneToGeoJSON(scene), {
  nodeStyle: (f) => Number(f.properties?.style),
  edgeStyle: (f) => Number(f.properties?.style),
}).scene
```

The [demo](../demo.md)'s "Import GeoJSON" button does exactly this with a small synthetic
graph, adds names and a few curved and great-circle links, serialises it to text and reads
it back, as loading a file would.

## From graphology

```ts
import Graph from 'graphology'
import { sceneFromGraph } from 'skeinmap'

const graph = new Graph()
graph.addNode('a', { lon: 9.19, lat: 45.46, kind: 'hub' })
graph.addNode('b', { lon: 12.49, lat: 41.9 })
graph.addEdge('a', 'b')

const { scene, nodeKeys, edgeKeys, nodeIndex } = sceneFromGraph(graph, {
  x: 'lon',
  y: 'lat',
  nodeStyle: (key, attributes) => (attributes.kind === 'hub' ? 1 : 0),
})
// a pick on node i → graph.getNodeAttributes(nodeKeys[i])
```

Positions are read from numeric node attributes (`x` / `y` by default). Nodes without
finite coordinates are skipped, together with the edges touching them. Edges are straight;
add paths with the helpers below if you need them. Any object with `forEachNode` and
`forEachEdge` in graphology's shape works; `order` and `size` are used as capacity hints
when present.

skeinmap does not lay graphs out: positions must already be there, from geography or from
a layout run elsewhere (for example graphology's layout packages).

## Curved and parallel edges

`curvedPath(ax, ay, bx, by, curvature?, segments?)` returns a quadratic Bézier curve from
`a` to `b` as a flat `[x0, y0, x1, y1, …]` array — the form `SceneBuilder.edge` takes as its
path. The control point sits on the perpendicular bisector of the chord, offset by
`curvature × chord length` (default 0.2, 16 segments).

Direction: a positive curvature bends to the **left** of a → b in a y-down frame (screen
pixels, the standalone view with identity projection) and to the **right** in a y-up frame
(longitude/latitude on a map).

Several edges between the same two nodes would draw on top of each other. Fan them out with
`parallelCurvature(index, count, spread?)`:

```ts
import { curvedPath, parallelCurvature, SceneBuilder } from 'skeinmap'

const b = new SceneBuilder()
const u = b.node(9.19, 45.46)
const v = b.node(11.25, 43.77)
const links = 3
for (let i = 0; i < links; i++) {
  // curvatures -0.15, 0, 0.15: the middle one stays straight
  b.edge(u, v, 0, curvedPath(9.19, 45.46, 11.25, 43.77, parallelCurvature(i, links)))
}
```

Compute all parallel edges between a pair in one canonical direction (for example from the
lower node index to the higher), even for edges stored the other way round: the sign of a
curvature is relative to a → b.

## Great-circle edges

On a Mercator map a straight line between two distant places is not the shortest route.
`greatCirclePath(lon1, lat1, lon2, lat2, segments?)` samples the great-circle arc (default
32 segments):

```ts
import { greatCirclePath } from 'skeinmap'

b.edge(london, singapore, 1, greatCirclePath(-0.13, 51.51, 103.82, 1.35, 64))
```

Longitudes stay continuous: an arc across the antimeridian goes past ±180 (170 → 185
rather than 170 → -175), so the polyline is drawn in one piece. With
[world copies](../concepts/adapters.md#world-copies) on, the part beyond 180 shows on the
next copy as it should. Identical endpoints give a two-point path; antipodal ones have no
unique arc, and the arc heads north from the start.

Arrowheads (`EdgeStyle.arrow`) follow the last segment of a path, so they point along a
curve or an arc at its end.
