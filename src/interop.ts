/**
 * Conversions between a {@link Scene} and common graph formats: GeoJSON feature
 * collections (import and export) and graphology-style graph objects (import).
 *
 * The input types are small structural interfaces, so objects typed with `@types/geojson`
 * or a `graphology` `Graph` are accepted as they are, without either package becoming a
 * dependency of skeinmap.
 *
 * @module
 */

import { type Scene, SceneBuilder } from './scene'

/** A GeoJSON position: `[longitude, latitude]`, optionally followed by an altitude (ignored). */
export type GeoJSONPosition = readonly number[]

/**
 * Any GeoJSON geometry, structurally. `Point`, `MultiPoint`, `LineString` and
 * `MultiLineString` are read by {@link sceneFromGeoJSON}; every other type is skipped.
 */
export interface GeoJSONGeometryLike {
  type: string
  coordinates?: unknown
}

/** A GeoJSON feature, structurally (an `@types/geojson` `Feature` fits). */
export interface GeoJSONFeatureLike {
  type?: string
  geometry: GeoJSONGeometryLike | null
  properties?: { [name: string]: unknown } | null
  id?: string | number
}

/** A GeoJSON feature collection, structurally (an `@types/geojson` `FeatureCollection` fits). */
export interface GeoJSONFeatureCollectionLike<F extends GeoJSONFeatureLike = GeoJSONFeatureLike> {
  type?: string
  features: readonly F[]
}

/** Options of {@link sceneFromGeoJSON}. */
export interface SceneFromGeoJSONOptions<F extends GeoJSONFeatureLike = GeoJSONFeatureLike> {
  /**
   * Style index (0–31) of the nodes made from a `Point` / `MultiPoint` feature. Called
   * once per feature, with the feature's index in the input. Default: 0.
   */
  nodeStyle?: (feature: F, index: number) => number
  /**
   * Style index (0–31) of the edges made from a `LineString` / `MultiLineString` feature.
   * Called once per feature, with the feature's index in the input. Default: 0.
   */
  edgeStyle?: (feature: F, index: number) => number
  /** Style index of the nodes created for line endpoints that match no point. Default: 0. */
  endpointStyle?: number
  /**
   * Distance in degrees (Euclidean, in longitude / latitude) within which a line endpoint
   * is attached to an existing node. Default: 0, an exact coordinate match.
   */
  snap?: number
}

/** Result of {@link sceneFromGeoJSON}. */
export interface SceneFromGeoJSONResult {
  scene: Scene
  /** Index in the input of the feature each node came from; -1 for a created line endpoint. */
  nodeFeature: Int32Array
  /** Index in the input of the feature each edge came from. */
  edgeFeature: Int32Array
  /**
   * Features that produced nothing: no geometry, an unsupported type (`Polygon`,
   * `GeometryCollection`, …), or no usable coordinates.
   */
  skipped: number
}

/**
 * Build a {@link Scene} from GeoJSON features.
 *
 * - Each position of a `Point` or `MultiPoint` becomes a node.
 * - Each line of a `LineString` or `MultiLineString` becomes one edge, drawn along the
 *   line (lines of more than two points are stored as the edge's path).
 * - A line's first and last positions are attached to the nearest existing node within
 *   `options.snap` degrees (an exact match by default). Points are indexed before any
 *   line is read, so a line attaches to a point that comes later in the collection.
 *   When no node matches, a node is created (its `nodeFeature` entry is -1) and indexed
 *   too, so lines meeting at the same position share one created node. A path end that
 *   was snapped is moved onto its node, so the drawn line meets the node exactly.
 * - Every other geometry is skipped and counted in `skipped`. Positions with
 *   non-finite coordinates are dropped; a line left with fewer than two positions is
 *   dropped.
 *
 * Matching uses a hash grid (or a hash map for exact matching), so it stays linear in
 * the number of features. When several points share a position, lines attach to the
 * first one.
 *
 * ```ts
 * const { scene, nodeFeature, edgeFeature } = sceneFromGeoJSON(collection, {
 *   nodeStyle: (f) => (f.properties?.kind === 'hub' ? 1 : 0),
 *   snap: 1e-6,
 * })
 * // later, from a pick: collection.features[nodeFeature[result.index]]
 * ```
 */
export function sceneFromGeoJSON<F extends GeoJSONFeatureLike>(
  input: GeoJSONFeatureCollectionLike<F> | readonly F[],
  options: SceneFromGeoJSONOptions<F> = {},
): SceneFromGeoJSONResult {
  const features: readonly F[] = isFeatureArray(input) ? input : input.features
  const snap = options.snap !== undefined && options.snap > 0 && Number.isFinite(options.snap) ? options.snap : 0
  const endpointStyle = options.endpointStyle ?? 0
  const builder = new SceneBuilder({ nodes: features.length, edges: features.length })
  const nodeFeature: number[] = []
  const edgeFeature: number[] = []
  const index = new NodeIndex(snap)
  const produced = new Uint8Array(features.length)
  const nodeX: number[] = []
  const nodeY: number[] = []

  const addNode = (x: number, y: number, style: number, feature: number): number => {
    const node = builder.node(x, y, style)
    nodeX.push(x)
    nodeY.push(y)
    nodeFeature.push(feature)
    index.insert(x, y, node)
    return node
  }

  // Pass 1: points.
  for (let i = 0; i < features.length; i++) {
    const feature = features[i]
    const geometry = feature?.geometry
    if (!geometry) continue
    let positions: unknown[] | null = null
    if (geometry.type === 'Point') positions = [geometry.coordinates]
    else if (geometry.type === 'MultiPoint' && Array.isArray(geometry.coordinates)) positions = geometry.coordinates
    if (!positions) continue
    let style: number | undefined
    for (const p of positions) {
      if (!isPosition(p)) continue
      style ??= options.nodeStyle ? options.nodeStyle(feature, i) : 0
      addNode(p[0], p[1], style, i)
      produced[i] = 1
    }
  }

  // Pass 2: lines.
  const endpoint = (x: number, y: number): number => {
    const found = index.find(x, y, nodeX, nodeY)
    return found >= 0 ? found : addNode(x, y, endpointStyle, -1)
  }
  for (let i = 0; i < features.length; i++) {
    const feature = features[i]
    const geometry = feature?.geometry
    if (!geometry || !Array.isArray(geometry.coordinates)) continue
    let lines: unknown[] | null = null
    if (geometry.type === 'LineString') lines = [geometry.coordinates]
    else if (geometry.type === 'MultiLineString') lines = geometry.coordinates
    if (!lines) continue
    let style: number | undefined
    for (const line of lines) {
      if (!Array.isArray(line)) continue
      const flat: number[] = []
      for (const p of line) if (isPosition(p)) flat.push(p[0], p[1])
      const last = flat.length - 2
      if (last < 2) continue
      style ??= options.edgeStyle ? options.edgeStyle(feature, i) : 0
      const from = endpoint(flat[0], flat[1])
      const to = endpoint(flat[last], flat[last + 1])
      if (flat.length > 4) {
        flat[0] = nodeX[from]
        flat[1] = nodeY[from]
        flat[last] = nodeX[to]
        flat[last + 1] = nodeY[to]
        builder.edge(from, to, style, flat)
      } else builder.edge(from, to, style)
      edgeFeature.push(i)
      produced[i] = 1
    }
  }

  let skipped = 0
  for (let i = 0; i < features.length; i++) if (!produced[i]) skipped++
  return {
    scene: builder.build(),
    nodeFeature: Int32Array.from(nodeFeature),
    edgeFeature: Int32Array.from(edgeFeature),
    skipped,
  }
}

function isFeatureArray<F>(input: GeoJSONFeatureCollectionLike | readonly F[]): input is readonly F[] {
  return Array.isArray(input)
}

function isPosition(p: unknown): p is GeoJSONPosition {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
}

/** Node lookup by position: a hash map for exact matching, a uniform hash grid for snapping. */
class NodeIndex {
  private readonly cells = new Map<string, number[]>()
  constructor(private readonly snap: number) {}

  private key(x: number, y: number): string {
    return this.snap > 0 ? `${Math.floor(x / this.snap)},${Math.floor(y / this.snap)}` : `${x},${y}`
  }

  insert(x: number, y: number, node: number): void {
    const k = this.key(x, y)
    const cell = this.cells.get(k)
    if (!cell) this.cells.set(k, [node])
    else if (this.snap > 0) cell.push(node)
    // Exact matching keeps only the first node at a position: lines attach to it.
  }

  /** The nearest node within `snap` of (x, y) (the first one on ties), or -1. */
  find(x: number, y: number, xs: readonly number[], ys: readonly number[]): number {
    if (this.snap === 0) return this.cells.get(this.key(x, y))?.[0] ?? -1
    const cx = Math.floor(x / this.snap)
    const cy = Math.floor(y / this.snap)
    let best = -1
    let bestD = this.snap * this.snap
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const cell = this.cells.get(`${gx},${gy}`)
        if (!cell) continue
        for (const node of cell) {
          const dx = xs[node] - x
          const dy = ys[node] - y
          const d = dx * dx + dy * dy
          if (d < bestD || (d === bestD && (best < 0 || node < best))) {
            best = node
            bestD = d
          }
        }
      }
    }
    return best
  }
}

/**
 * A graph, structurally: the subset of the `graphology` `Graph` API that
 * {@link sceneFromGraph} uses, so a graphology graph can be passed as is.
 */
export interface GraphLike<NodeAttributes extends object = object, EdgeAttributes extends object = object> {
  /** Number of nodes, used as a capacity hint when present. */
  readonly order?: number
  /** Number of edges, used as a capacity hint when present. */
  readonly size?: number
  /** Call `callback` once per node. */
  forEachNode(callback: (key: string, attributes: NodeAttributes) => void): void
  /** Call `callback` once per edge, with the keys of its two ends. */
  forEachEdge(callback: (key: string, attributes: EdgeAttributes, source: string, target: string) => void): void
}

/** Options of {@link sceneFromGraph}. */
export interface SceneFromGraphOptions<NodeAttributes extends object = object, EdgeAttributes extends object = object> {
  /** Node attribute holding x (longitude on a map). Default: `'x'`. */
  x?: string
  /** Node attribute holding y (latitude on a map). Default: `'y'`. */
  y?: string
  /** Style index (0–31) of a node. Default: 0. */
  nodeStyle?: (key: string, attributes: NodeAttributes) => number
  /** Style index (0–31) of an edge. Default: 0. */
  edgeStyle?: (key: string, attributes: EdgeAttributes, source: string, target: string) => number
}

/** Result of {@link sceneFromGraph}. */
export interface SceneFromGraphResult {
  scene: Scene
  /** Graph key of each scene node, by node index. */
  nodeKeys: string[]
  /** Graph key of each scene edge, by edge index. */
  edgeKeys: string[]
  /** Scene node index of each kept graph node key. */
  nodeIndex: Map<string, number>
}

/**
 * Build a {@link Scene} from a graphology-style graph whose nodes carry their position
 * as numeric attributes (`x` / `y` by default; longitude / latitude for a map adapter).
 *
 * Nodes without finite numeric coordinates are skipped, and so are the edges touching
 * them. Edges keep the graph's straight lines (no path).
 *
 * ```ts
 * import Graph from 'graphology'
 * const graph = new Graph()
 * graph.addNode('mil', { lon: 9.19, lat: 45.46 })
 * graph.addNode('rom', { lon: 12.49, lat: 41.9 })
 * graph.addEdge('mil', 'rom')
 * const { scene, nodeKeys } = sceneFromGraph(graph, { x: 'lon', y: 'lat' })
 * // a pick on node i → graph.getNodeAttributes(nodeKeys[i])
 * ```
 */
export function sceneFromGraph<NodeAttributes extends object = object, EdgeAttributes extends object = object>(
  graph: GraphLike<NodeAttributes, EdgeAttributes>,
  options: SceneFromGraphOptions<NodeAttributes, EdgeAttributes> = {},
): SceneFromGraphResult {
  const xName = options.x ?? 'x'
  const yName = options.y ?? 'y'
  const builder = new SceneBuilder({ nodes: graph.order, edges: graph.size })
  const nodeKeys: string[] = []
  const edgeKeys: string[] = []
  const nodeIndex = new Map<string, number>()
  graph.forEachNode((key, attributes) => {
    const record = attributes as Record<string, unknown> | null | undefined
    const x = record?.[xName]
    const y = record?.[yName]
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return
    nodeIndex.set(key, builder.node(x, y, options.nodeStyle ? options.nodeStyle(key, attributes) : 0))
    nodeKeys.push(key)
  })
  graph.forEachEdge((key, attributes, source, target) => {
    const from = nodeIndex.get(source)
    const to = nodeIndex.get(target)
    if (from === undefined || to === undefined) return
    builder.edge(from, to, options.edgeStyle ? options.edgeStyle(key, attributes, source, target) : 0)
    edgeKeys.push(key)
  })
  return { scene: builder.build(), nodeKeys, edgeKeys, nodeIndex }
}

/** A node exported by {@link sceneToGeoJSON}. */
export interface SceneNodeFeature {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: { index: number; style: number }
}

/** An edge exported by {@link sceneToGeoJSON}. */
export interface SceneEdgeFeature {
  type: 'Feature'
  geometry: { type: 'LineString'; coordinates: [number, number][] }
  properties: { index: number; from: number; to: number; style: number }
}

/** The feature collection returned by {@link sceneToGeoJSON}. */
export interface SceneFeatureCollection {
  type: 'FeatureCollection'
  features: (SceneNodeFeature | SceneEdgeFeature)[]
}

/**
 * Export a {@link Scene} as a GeoJSON feature collection: one `Point` per node
 * (properties `{ index, style }`), then one `LineString` per edge (properties
 * `{ index, from, to, style }`, `from` / `to` being node indices), drawn along the edge's
 * path when it has one and straight between its two nodes otherwise.
 *
 * {@link sceneFromGeoJSON} reads the result back into the same nodes and edges, as long
 * as every edge path starts and ends on its nodes and no two nodes share a position:
 *
 * ```ts
 * const back = sceneFromGeoJSON(sceneToGeoJSON(scene), {
 *   nodeStyle: (f) => Number(f.properties?.style),
 *   edgeStyle: (f) => Number(f.properties?.style),
 * }).scene
 * ```
 */
export function sceneToGeoJSON(scene: Scene): SceneFeatureCollection {
  const features: (SceneNodeFeature | SceneEdgeFeature)[] = []
  for (let i = 0; i < scene.nodeCount; i++) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [scene.nodeX[i], scene.nodeY[i]] },
      properties: { index: i, style: scene.nodeStyle[i] },
    })
  }
  const { edgePathStart: starts, edgePathEnd: ends, pathX, pathY } = scene
  for (let e = 0; e < scene.edgeCount; e++) {
    const from = scene.edgeFrom[e]
    const to = scene.edgeTo[e]
    let coordinates: [number, number][]
    if (starts && ends && pathX && pathY && ends[e] - starts[e] >= 2) {
      coordinates = []
      for (let k = starts[e]; k < ends[e]; k++) coordinates.push([pathX[k], pathY[k]])
    } else {
      coordinates = [
        [scene.nodeX[from], scene.nodeY[from]],
        [scene.nodeX[to], scene.nodeY[to]],
      ]
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: { index: e, from, to, style: scene.edgeStyle[e] },
    })
  }
  return { type: 'FeatureCollection', features }
}
