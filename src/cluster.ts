import { kernels } from './kernels/index'
import { KeyTable, projectMercatorTs } from './kernels/ts'
import {
  DEFAULT_CLUSTER_CELL_PX,
  HIDDEN_STYLE,
  NO_CLUSTER,
  type ClusterLevel,
  type Clusterer,
  type Kernels,
} from './kernels/types'
import { MERCATOR_WORLD, mercatorInverse } from './projection'
import type { Scene } from './scene'

/**
 * Grid clustering of a scene's nodes, per zoom: each occupied screen cell becomes one
 * node at the centroid of its members, and edges are aggregated between clusters. The
 * clustering runs on the active kernels ({@link kernels}: WebAssembly once loaded), which
 * produce the same clusters either way.
 *
 * ```ts
 * const index = createClusterIndex(scene)
 * const { scene: clustered, counts, members } = index.level(Math.round(map.getZoom()))
 * layer.setScene(clustered)
 * ```
 *
 * @module
 */

/** Options of {@link createClusterIndex}. */
export interface ClusterIndexOptions {
  /**
   * How the scene's coordinates become units (the plane cells are counted in):
   * `mercator` (longitude/latitude, the default) or `identity` (already units, as in the
   * standalone view).
   */
  projection?: 'mercator' | 'identity'
  /** Cell width in pixels at the level's zoom. Default 60. */
  cellPx?: number
}

/** The clusters of one zoom (see {@link ClusterIndex.level}). */
export interface ClusterView {
  /**
   * One node per cluster, at its centroid in scene coordinates (the mean of the members'
   * unit positions, converted back). `nodeStyle` is 0 for a single node and 1 for a
   * cluster of several — rewrite it to style clusters your way. One edge (style 0, no
   * path) per unordered pair of distinct clusters joined by at least one visible edge,
   * in order of the first such original edge, and in its direction.
   */
  scene: Scene
  /** Members per cluster. */
  counts: Uint32Array
  /** Cluster of each original node, or `0xFFFFFFFF` for a hidden one (style 255). */
  clusterOf: Uint32Array
  /**
   * The original node indices of `cluster`, ascending (empty for an unknown cluster). A
   * view into storage shared by every call: do not modify it.
   */
  members(cluster: number): Uint32Array
}

/** Clusters of one scene, cached per zoom. */
export interface ClusterIndex {
  /** The clusters at `zoom` (one unit is `2^zoom` pixels); computed once per zoom. */
  level(zoom: number): ClusterView
  /** Drop the cached levels and the memory held on the kernel side. */
  dispose(): void
}

/** Cached levels kept at most (the least recently computed goes first). */
const MAX_CACHED_LEVELS = 32

const EMPTY = new Uint32Array(0)

/**
 * Index `scene` for grid clustering. Nodes with style 255 are hidden: they join no
 * cluster, and edges touching them (or with style 255 themselves) are left out. The scene
 * is read when the index is created (positions are projected once); create a new index
 * for a new scene.
 *
 * With `identity`, cells are counted from the top-left of the nodes' bounding box; cell
 * keys stay exact while `span · 2^zoom / cellPx` is below 2^26 (see `lodFits`).
 */
export function createClusterIndex(scene: Scene, options: ClusterIndexOptions = {}): ClusterIndex {
  const projection = options.projection ?? 'mercator'
  const cellPx = options.cellPx ?? DEFAULT_CLUSTER_CELL_PX
  const n = scene.nodeCount
  let unitX: Float64Array
  let unitY: Float64Array
  let bounds: [number, number, number, number]
  if (projection === 'mercator') {
    unitX = new Float64Array(n)
    unitY = new Float64Array(n)
    // Always the TypeScript projection: the clusters must not depend on which kernels
    // were active when the index was created (the WASM one differs in the last ulps).
    projectMercatorTs(scene.nodeX, scene.nodeY, unitX, unitY, n)
    bounds = [0, 0, MERCATOR_WORLD, MERCATOR_WORLD]
  } else {
    unitX = scene.nodeX
    unitY = scene.nodeY
    bounds = finiteBounds(unitX, unitY, n)
  }
  const nodeStyle = scene.nodeStyle

  const cache = new Map<number, ClusterView>()
  let clusterer: Clusterer | null = null
  let clustererKernels: Kernels | null = null
  let disposed = false

  const compute = (zoom: number): ClusterLevel => {
    const k = kernels()
    if (clusterer && clustererKernels !== k) {
      clusterer.dispose()
      clusterer = null
    }
    if (!clusterer) {
      clusterer = k.createClusterer(unitX, unitY, nodeStyle, n, bounds)
      clustererKernels = k
    }
    return clusterer.level(zoom, cellPx)
  }

  return {
    level(zoom: number): ClusterView {
      if (disposed) throw new Error('ClusterIndex used after dispose()')
      const hit = cache.get(zoom)
      if (hit) return hit
      const view = buildView(scene, compute(zoom), projection)
      if (cache.size >= MAX_CACHED_LEVELS) cache.delete(cache.keys().next().value!)
      cache.set(zoom, view)
      return view
    },
    dispose(): void {
      disposed = true
      cache.clear()
      clusterer?.dispose()
      clusterer = null
      clustererKernels = null
    },
  }
}

/** `[x0, y0, x1, y1]` of the finite positions, or a unit square when there are none. */
function finiteBounds(xs: Float64Array, ys: Float64Array, n: number): [number, number, number, number] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < n; i++) {
    const x = xs[i]
    const y = ys[i]
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return x0 === Infinity ? [0, 0, 1, 1] : [x0, y0, x1, y1]
}

function buildView(source: Scene, level: ClusterLevel, projection: 'mercator' | 'identity'): ClusterView {
  const clusters = level.count.length
  const { clusterOf, count } = level

  // Cluster nodes.
  let nodeX = level.x
  let nodeY = level.y
  if (projection === 'mercator') {
    nodeX = new Float64Array(clusters)
    nodeY = new Float64Array(clusters)
    for (let c = 0; c < clusters; c++) {
      const [lon, lat] = mercatorInverse(level.x[c], level.y[c])
      nodeX[c] = lon
      nodeY[c] = lat
    }
  }
  const nodeStyle = new Uint8Array(clusters)
  for (let c = 0; c < clusters; c++) nodeStyle[c] = count[c] > 1 ? 1 : 0

  // Aggregated edges: one per unordered pair of distinct clusters, first appearance first.
  const m = source.edgeCount
  const from: number[] = []
  const to: number[] = []
  const pairs = new KeyTable(Math.min(m, 1 << 20))
  for (let e = 0; e < m; e++) {
    if (source.edgeStyle[e] === HIDDEN_STYLE) continue
    const a = clusterOf[source.edgeFrom[e]]
    const b = clusterOf[source.edgeTo[e]]
    // Hidden ends, and ends that refer to no node (undefined), are left out.
    if (a === undefined || b === undefined || a === NO_CLUSTER || b === NO_CLUSTER || a === b) continue
    const lo = a < b ? a : b
    const hi = a < b ? b : a
    const slot = pairs.slot(lo, hi)
    if (pairs.vals[slot] !== 0) continue
    pairs.vals[slot] = 1
    from.push(a)
    to.push(b)
  }
  const edgeCount = from.length

  const scene: Scene = {
    nodeCount: clusters,
    nodeX,
    nodeY,
    nodeStyle,
    edgeCount,
    edgeFrom: Uint32Array.from(from),
    edgeTo: Uint32Array.from(to),
    edgeStyle: new Uint8Array(edgeCount),
  }

  // Members as compressed rows, built on first use.
  let start: Uint32Array | null = null
  let items: Uint32Array | null = null
  const members = (cluster: number): Uint32Array => {
    if (!(cluster >= 0 && cluster < clusters) || !Number.isInteger(cluster)) return EMPTY
    if (!start || !items) {
      start = new Uint32Array(clusters + 1)
      for (let c = 0; c < clusters; c++) start[c + 1] = start[c] + count[c]
      items = new Uint32Array(start[clusters])
      const fill = start.slice(0, clusters)
      for (let i = 0; i < clusterOf.length; i++) {
        const c = clusterOf[i]
        if (c !== NO_CLUSTER) items[fill[c]++] = i
      }
    }
    return items.subarray(start[cluster], start[cluster + 1])
  }

  return { scene, counts: count, clusterOf, members }
}
