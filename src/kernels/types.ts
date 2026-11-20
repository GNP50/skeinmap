/**
 * The hot paths, as an interface with two implementations: pure TypeScript (always
 * available) and WebAssembly (after {@link initWasm}). Both produce the same output for
 * the same input — the test suite checks it — so switching is a speed decision only.
 *
 * @module
 */

/**
 * The style byte reserved for hidden elements (filtered out). A node with this style is
 * never kept by a level of detail nor assigned to a cluster; an edge with it produces no
 * segments. Styles 0–254 are drawn (the level of detail uses `style & 31`).
 */
export const HIDDEN_STYLE = 255

/** {@link ClusterLevel.clusterOf} of a hidden node. */
export const NO_CLUSTER = 0xffffffff

/** Geometry a level of detail is computed from: positions already in units. */
export interface LodGeometry {
  nodeCount: number
  unitX: Float64Array
  unitY: Float64Array
  nodeStyle: Uint8Array
  edgeCount: number
  edgeFrom: Uint32Array
  edgeTo: Uint32Array
  edgeStyle: Uint8Array
  edgePathStart?: Uint32Array
  edgePathEnd?: Uint32Array
  unitPX?: Float64Array
  unitPY?: Float64Array
  /**
   * `[x0, y0, x1, y1]` covering every position, in units. Cells are counted from
   * `(x0, y0)`. Default: the Mercator world `[0, 0, 256, 256]`. Cell keys must stay exact
   * in a double, so `(x1 - x0) · 2^zoom / cellPx` must stay below 2^26 — see
   * {@link lodFits}.
   */
  bounds?: readonly [number, number, number, number]
}

/** Whether a level at `zoom` keeps exact cell keys for `bounds` (see {@link LodGeometry.bounds}). */
export function lodFits(bounds: readonly [number, number, number, number], zoom: number, cellPx = 2): boolean {
  const span = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1])
  return Number.isFinite(span) && (span * Math.pow(2, zoom)) / cellPx < 2 ** 26
}

/**
 * One level of detail: the subset of nodes and edge segments that is visually
 * indistinguishable from the whole scene at that zoom. Segment `s` belongs to edge
 * `segEdge[s]`; `segP0/segP1` are path-point indices of a routed edge, or -1 for a
 * straight edge (drawn between its two nodes).
 */
export interface LodLevel {
  zoom: number
  nodes: Uint32Array
  segEdge: Uint32Array
  segP0: Int32Array
  segP1: Int32Array
}

/** Computes levels of detail for one geometry (held between calls). */
export interface LodComputer {
  /** The level for `zoom`, where one unit is `2^zoom` pixels; cells are `cellPx` wide. */
  level(zoom: number, cellPx?: number): LodLevel
  /** Release memory held for the geometry (WASM side). */
  dispose(): void
}

/**
 * Nodes grouped by grid cell at one zoom: every visible node in a cell of `cellPx` pixels
 * (`cellPx / 2^zoom` units, cells counted from the bounds origin exactly as the level of
 * detail counts them) belongs to that cell's cluster. A node with a NaN position forms a
 * cluster of its own. Cluster ids follow the first appearance of their cell in node index
 * order, so they do not depend on hashing.
 */
export interface ClusterLevel {
  zoom: number
  /** Cluster id per node (0 .. clusters - 1), or {@link NO_CLUSTER} for a hidden node (style 255). */
  clusterOf: Uint32Array
  /** Per cluster: centroid x in units (mean of member positions, summed in node index order). */
  x: Float64Array
  /** Per cluster: centroid y in units. */
  y: Float64Array
  /** Per cluster: member count. */
  count: Uint32Array
}

/**
 * Clusters one fixed set of positions repeatedly (once per zoom, say). The positions are
 * captured when it is created — the WASM side copies them once — so each call costs only
 * the clustering; do not modify the arrays while it is in use.
 */
export interface Clusterer {
  /** The clusters at `zoom` (one unit is `2^zoom` pixels) with cells `cellPx` wide (default 60). */
  level(zoom: number, cellPx?: number): ClusterLevel
  /** Release memory held for the positions (WASM side). */
  dispose(): void
}

/** Default cell width of {@link Kernels.clusterLevel} and {@link Clusterer.level}, in pixels. */
export const DEFAULT_CLUSTER_CELL_PX = 60

/** The part of a scene a hit-test grid needs that does not change with the view. */
export interface GridTopology {
  nodeCount: number
  edgeCount: number
  edgeFrom: Uint32Array
  edgeTo: Uint32Array
}

/** A rectangle in absolute pixel coordinates. */
export interface GridWindow {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Positions for one grid build: absolute pixel coordinates at the current view. */
export interface GridPositions {
  projX: Float64Array
  projY: Float64Array
  /**
   * Per-edge drawn box `[x0, y0, x1, y1]` (absolute px) for routed edges; `NaN` in slot
   * 0 for a straight edge (its two endpoints are used).
   */
  edgeBox?: Float64Array
}

/**
 * A uniform grid over a window, as compressed rows: the items of cell `c` are
 * `nodeItems[nodeStart[c] .. nodeStart[c + 1])` (likewise for edges). Edges whose box
 * covers more than {@link MAX_EDGE_CELLS} cells are listed in `longEdges` instead and
 * visited by every query.
 */
export interface GridData {
  win: GridWindow
  cell: number
  cols: number
  rows: number
  nodeStart: Uint32Array
  nodeItems: Uint32Array
  edgeStart: Uint32Array
  edgeItems: Uint32Array
  longEdges: Uint32Array
}

/** Edges covering more cells than this go to {@link GridData.longEdges}. */
export const MAX_EDGE_CELLS = 64

/** Builds hit-test grids for one scene topology (held between calls). */
export interface GridBuilder {
  build(positions: GridPositions, win: GridWindow, cell: number): GridData
  dispose(): void
}

/**
 * Simplifies one fixed set of polylines repeatedly (once per zoom level, say). The points
 * and ranges are captured when it is created — the WASM side copies them once — so each
 * call costs only the simplification; do not modify the arrays while it is in use.
 */
export interface Simplifier {
  /** Same output as {@link Kernels.simplifyPaths} over the captured polylines. */
  simplify(tolerance: number, keep: Uint8Array): void
  /** Release memory held for the polylines (WASM side). */
  dispose(): void
}

/** The kernel set. Obtain the active one with {@link kernels}. */
export interface Kernels {
  readonly name: 'wasm' | 'ts'
  /** Spherical Mercator for `count` points (x = longitude, y = latitude) into units. */
  projectMercator(xs: Float64Array, ys: Float64Array, outX: Float64Array, outY: Float64Array, count: number): void
  createLod(geometry: LodGeometry): LodComputer
  createGridBuilder(topology: GridTopology): GridBuilder
  /**
   * Douglas–Peucker over every polyline range `[starts[e], ends[e])` for `e < count`
   * (ranges under three points keep every point). Writes 1 into `keep[p]` for kept
   * points and 0 for dropped ones; points outside every range are left untouched.
   * `tolerance` is in the same units as the coordinates.
   */
  simplifyPaths(
    xs: Float64Array,
    ys: Float64Array,
    starts: Uint32Array,
    ends: Uint32Array,
    count: number,
    tolerance: number,
    keep: Uint8Array,
  ): void
  /**
   * A {@link Simplifier} for the ranges `[starts[e], ends[e])`, `e < count`, over the
   * points `xs`/`ys`: for polylines simplified at several tolerances.
   */
  createSimplifier(
    xs: Float64Array,
    ys: Float64Array,
    starts: Uint32Array,
    ends: Uint32Array,
    count: number,
  ): Simplifier
  /**
   * Grid clustering of `count` positions in units (see {@link ClusterLevel}). `cellPx`
   * defaults to {@link DEFAULT_CLUSTER_CELL_PX}, `bounds` to the Mercator world
   * `[0, 0, 256, 256]` (the same rule as {@link LodGeometry.bounds}).
   */
  clusterLevel(
    unitX: Float64Array,
    unitY: Float64Array,
    nodeStyle: Uint8Array,
    count: number,
    zoom: number,
    cellPx?: number,
    bounds?: readonly [number, number, number, number],
  ): ClusterLevel
  /** A {@link Clusterer} over the first `count` positions: for clustering at several zooms. */
  createClusterer(
    unitX: Float64Array,
    unitY: Float64Array,
    nodeStyle: Uint8Array,
    count: number,
    bounds?: readonly [number, number, number, number],
  ): Clusterer
}
