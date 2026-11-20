import { MAX_MERCATOR_LAT, MERCATOR_WORLD } from '../projection'
import {
  DEFAULT_CLUSTER_CELL_PX,
  HIDDEN_STYLE,
  MAX_EDGE_CELLS,
  NO_CLUSTER,
  type ClusterLevel,
  type Clusterer,
  type GridBuilder,
  type GridData,
  type GridPositions,
  type GridTopology,
  type GridWindow,
  type Kernels,
  type LodComputer,
  type LodGeometry,
  type LodLevel,
  type Simplifier,
} from './types'

/**
 * The pure TypeScript kernels. The Rust crate in `crates/` mirrors every function here
 * operation for operation, so that both produce the same output; keep them in step.
 *
 * @module
 */

// ── Projection ─────────────────────────────────────────────────────────────────

const DEG = Math.PI / 180
const INV_4PI = 1 / (4 * Math.PI)

export function projectMercatorTs(
  xs: Float64Array,
  ys: Float64Array,
  outX: Float64Array,
  outY: Float64Array,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const lat = ys[i]
    const clamped = lat > MAX_MERCATOR_LAT ? MAX_MERCATOR_LAT : lat < -MAX_MERCATOR_LAT ? -MAX_MERCATOR_LAT : lat
    const sin = Math.sin(clamped * DEG)
    outX[i] = MERCATOR_WORLD * (0.5 + xs[i] / 360)
    outY[i] = MERCATOR_WORLD * (0.5 - Math.log((1 + sin) / (1 - sin)) * INV_4PI)
  }
}

// ── Level of detail ────────────────────────────────────────────────────────────

const MERCATOR_BOUNDS: readonly [number, number, number, number] = [0, 0, MERCATOR_WORLD, MERCATOR_WORLD]

/**
 * Open-addressing hash table of integer keys (pairs) with a 32-bit payload. It doubles
 * when half full, so it never runs out of slots (NaN keys, which match nothing, take a
 * fresh slot each time). Which slot a key lands in never affects kernel output.
 */
export class KeyTable {
  private keys: Float64Array
  private keys2: Float64Array
  vals: Uint32Array
  private used: Uint8Array
  private mask: number
  private size = 0

  constructor(expected: number) {
    let cap = 16
    while (cap < expected * 2) cap *= 2
    this.keys = new Float64Array(cap)
    this.keys2 = new Float64Array(cap)
    this.vals = new Uint32Array(cap)
    this.used = new Uint8Array(cap)
    this.mask = cap - 1
  }

  private static hash(a: number, b: number): number {
    let h = Math.imul((a % 4294967296) ^ Math.floor(a / 4294967296), 0x9e3779b1)
    h = Math.imul(h ^ (b % 4294967296) ^ Math.floor(b / 4294967296), 0x85ebca6b)
    return h ^ (h >>> 15)
  }

  private grow(): void {
    const { keys, keys2, vals, used } = this
    const cap = keys.length * 2
    this.keys = new Float64Array(cap)
    this.keys2 = new Float64Array(cap)
    this.vals = new Uint32Array(cap)
    this.used = new Uint8Array(cap)
    this.mask = cap - 1
    for (let j = 0; j < used.length; j++) {
      if (!used[j]) continue
      let i = KeyTable.hash(keys[j], keys2[j]) & this.mask
      while (this.used[i]) i = (i + 1) & this.mask
      this.used[i] = 1
      this.keys[i] = keys[j]
      this.keys2[i] = keys2[j]
      this.vals[i] = vals[j]
    }
  }

  /**
   * Slot of `(a, b)` in {@link vals}, inserted if absent (read `vals` after the call: it
   * may have been reallocated). Keys are integers below 2^53 in magnitude.
   */
  slot(a: number, b: number): number {
    if ((this.size + 1) * 2 > this.used.length) this.grow()
    let i = KeyTable.hash(a, b) & this.mask
    while (this.used[i]) {
      if (this.keys[i] === a && this.keys2[i] === b) return i
      i = (i + 1) & this.mask
    }
    this.used[i] = 1
    this.keys[i] = a
    this.keys2[i] = b
    this.size++
    return i
  }
}

/** Growable Int32 storage for segment lists. */
class IntList {
  data: Int32Array
  length = 0
  constructor(capacity: number) {
    this.data = new Int32Array(Math.max(16, capacity))
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Int32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = v
  }
}

/**
 * Bin positions into `cellPx` cells at `zoom` (in units, so one result holds for the
 * whole zoom level). Per cell one node *per style* is kept; a straight edge whose ends
 * share a cell is dropped; edges joining the same two cells with the same style are
 * drawn once; a routed edge keeps one point per cell it crosses. Hidden elements (style
 * {@link HIDDEN_STYLE}) are left out: a hidden node is never kept, a hidden edge produces
 * no segment.
 */
export function computeLodLevelTs(g: LodGeometry, zoom: number, cellPx = 2): LodLevel {
  const cell = cellPx / Math.pow(2, zoom)
  const [bx0, by0, bx1] = g.bounds ?? MERCATOR_BOUNDS
  const cols = Math.ceil((bx1 - bx0) / cell) + 1
  const cellOf = (x: number, y: number) => Math.floor((x - bx0) / cell) + Math.floor((y - by0) / cell) * cols

  // Nodes: one per (cell, style).
  const nodeCell = new Float64Array(g.nodeCount)
  const nodeTable = new KeyTable(g.nodeCount)
  const keep = new Uint32Array(g.nodeCount)
  let kept = 0
  for (let i = 0; i < g.nodeCount; i++) {
    const c = cellOf(g.unitX[i], g.unitY[i])
    nodeCell[i] = c
    const style = g.nodeStyle[i]
    if (style === HIDDEN_STYLE) continue
    const slot = nodeTable.slot(c, 0)
    const bit = (1 << (style & 31)) >>> 0
    if ((nodeTable.vals[slot] & bit) !== 0) continue
    nodeTable.vals[slot] = (nodeTable.vals[slot] | bit) >>> 0
    keep[kept++] = i
  }

  // Edges.
  const segEdge = new IntList(g.edgeCount)
  const segP0 = new IntList(g.edgeCount)
  const segP1 = new IntList(g.edgeCount)
  const pairTable = new KeyTable(Math.min(g.edgeCount, 1 << 22))
  const starts = g.edgePathStart
  const ends = g.edgePathEnd
  const px = g.unitPX
  const py = g.unitPY
  for (let e = 0; e < g.edgeCount; e++) {
    const style = g.edgeStyle[e]
    if (style === HIDDEN_STYLE) continue
    if (starts && ends && px && py && ends[e] - starts[e] >= 2) {
      // A routed edge: one point per cell it crosses.
      let last = starts[e]
      let lastCell = cellOf(px[last], py[last])
      for (let p = starts[e] + 1; p < ends[e]; p++) {
        const c = cellOf(px[p], py[p])
        if (c === lastCell && p < ends[e] - 1) continue
        if (c !== lastCell) {
          segEdge.push(e)
          segP0.push(last)
          segP1.push(p)
        }
        last = p
        lastCell = c
      }
      continue
    }
    const a = nodeCell[g.edgeFrom[e]]
    const b = nodeCell[g.edgeTo[e]]
    if (a === b) continue
    const slot = pairTable.slot(Math.min(a, b), Math.max(a, b))
    const bit = (1 << (style & 31)) >>> 0
    if ((pairTable.vals[slot] & bit) !== 0) continue
    pairTable.vals[slot] = (pairTable.vals[slot] | bit) >>> 0
    segEdge.push(e)
    segP0.push(-1)
    segP1.push(-1)
  }

  return {
    zoom,
    nodes: keep.slice(0, kept),
    segEdge: new Uint32Array(segEdge.data.buffer.slice(0, segEdge.length * 4)),
    segP0: segP0.data.slice(0, segP0.length),
    segP1: segP1.data.slice(0, segP1.length),
  }
}

// ── Clustering ─────────────────────────────────────────────────────────────────

/**
 * Grid clustering (see {@link ClusterLevel}): one cluster per occupied `cellPx` cell at
 * `zoom`, keyed exactly like {@link computeLodLevelTs}; a NaN key (a NaN position) makes
 * a singleton. Ids in order of first appearance; centroid sums accumulated in node index
 * order, then divided by the member count.
 */
export function computeClusterLevelTs(
  unitX: Float64Array,
  unitY: Float64Array,
  nodeStyle: Uint8Array,
  count: number,
  zoom: number,
  cellPx = DEFAULT_CLUSTER_CELL_PX,
  bounds: readonly [number, number, number, number] = MERCATOR_BOUNDS,
): ClusterLevel {
  const cell = cellPx / Math.pow(2, zoom)
  const [bx0, by0, bx1, by1] = bounds
  const cols = Math.ceil((bx1 - bx0) / cell) + 1
  // Sizing only (never affects the output): at most one cluster per cell, plus NaNs.
  const cells = cols * (Math.ceil((by1 - by0) / cell) + 1)
  const expected = cells >= 0 && cells < count ? cells : count
  const table = new KeyTable(expected)
  const clusterOf = new Uint32Array(count)
  let cap = Math.max(16, Math.min(count, expected + 16))
  let sx = new Float64Array(cap)
  let sy = new Float64Array(cap)
  let n = new Uint32Array(cap)
  let clusters = 0
  for (let i = 0; i < count; i++) {
    if (nodeStyle[i] === HIDDEN_STYLE) {
      clusterOf[i] = NO_CLUSTER
      continue
    }
    const x = unitX[i]
    const y = unitY[i]
    const c = Math.floor((x - bx0) / cell) + Math.floor((y - by0) / cell) * cols
    let id: number
    if (c !== c) {
      id = clusters++ // a NaN key matches nothing: a cluster of its own
    } else {
      const slot = table.slot(c, 0)
      const v = table.vals[slot]
      if (v === 0) {
        id = clusters++
        table.vals[slot] = clusters
      } else {
        id = v - 1
      }
    }
    if (id === cap) {
      cap *= 2
      const nx = new Float64Array(cap)
      const ny = new Float64Array(cap)
      const nn = new Uint32Array(cap)
      nx.set(sx)
      ny.set(sy)
      nn.set(n)
      sx = nx
      sy = ny
      n = nn
    }
    clusterOf[i] = id
    sx[id] += x
    sy[id] += y
    n[id]++
  }
  const outX = new Float64Array(clusters)
  const outY = new Float64Array(clusters)
  for (let k = 0; k < clusters; k++) {
    outX[k] = sx[k] / n[k]
    outY[k] = sy[k] / n[k]
  }
  return { zoom, clusterOf, x: outX, y: outY, count: n.slice(0, clusters) }
}

// ── Hit-test grid ──────────────────────────────────────────────────────────────

/**
 * A uniform grid over `win`: nodes by the cell they fall in (counting sort), edges by
 * every cell their box covers (clipped to the window). Two linear passes each; the first
 * edge pass stores each edge's cell rectangle so the second does not recompute it.
 */
export function buildGridTs(topology: GridTopology, positions: GridPositions, win: GridWindow, cell: number): GridData {
  const cols = Math.max(1, Math.ceil((win.x1 - win.x0) / cell))
  const rows = Math.max(1, Math.ceil((win.y1 - win.y0) / cell))
  // A NaN or infinite window, a non-positive cell, or an absurd cell count: an empty grid
  // (every query finds nothing) rather than corrupt rows or an unbounded allocation.
  if (!(cell > 0 && cols * rows <= MAX_GRID_CELLS)) return emptyGrid(win, cell)
  const cells = cols * rows
  const { nodeCount, edgeCount, edgeFrom, edgeTo } = topology
  const { projX, projY, edgeBox } = positions
  const { x0: wx0, y0: wy0, x1: wx1, y1: wy1 } = win
  const lastCol = cols - 1
  const lastRow = rows - 1

  // Nodes: counting sort by cell.
  const nodeCell = new Int32Array(nodeCount)
  const nodeStart = new Uint32Array(cells + 1)
  let inside = 0
  for (let i = 0; i < nodeCount; i++) {
    const x = projX[i]
    const y = projY[i]
    // Written so that NaN fails it.
    if (!(x >= wx0 && x < wx1 && y >= wy0 && y < wy1)) {
      nodeCell[i] = -1
      continue
    }
    // Never negative here; clamped above: `x - wx0` can round up to the window width.
    let cx = Math.floor((x - wx0) / cell)
    let cy = Math.floor((y - wy0) / cell)
    if (cx > lastCol) cx = lastCol
    if (cy > lastRow) cy = lastRow
    const c = cy * cols + cx
    nodeCell[i] = c
    nodeStart[c + 1]++
    inside++
  }
  for (let c = 0; c < cells; c++) nodeStart[c + 1] += nodeStart[c]
  const nodeItems = new Uint32Array(inside)
  const nodeFill = nodeStart.slice(0, cells)
  for (let i = 0; i < nodeCount; i++) {
    const c = nodeCell[i]
    if (c >= 0) nodeItems[nodeFill[c]++] = i
  }

  // Edges: by every cell their box covers. The first pass counts and records each
  // gridded edge's first cell and its width and height in cells (both at most
  // MAX_EDGE_CELLS; width 0 marks an edge outside the window or a long one).
  const edgeStart = new Uint32Array(cells + 1)
  const edgeCell = new Int32Array(edgeCount)
  const edgeW = new Uint8Array(edgeCount)
  const edgeH = new Uint8Array(edgeCount)
  const longList: number[] = []
  for (let e = 0; e < edgeCount; e++) {
    let x0: number, y0: number, x1: number, y1: number
    if (edgeBox && edgeBox[e * 4] === edgeBox[e * 4]) {
      x0 = edgeBox[e * 4]
      y0 = edgeBox[e * 4 + 1]
      x1 = edgeBox[e * 4 + 2]
      y1 = edgeBox[e * 4 + 3]
    } else {
      const ax = projX[edgeFrom[e]]
      const bx = projX[edgeTo[e]]
      const ay = projY[edgeFrom[e]]
      const by = projY[edgeTo[e]]
      x0 = ax < bx ? ax : bx
      x1 = ax < bx ? bx : ax
      y0 = ay < by ? ay : by
      y1 = ay < by ? by : ay
    }
    // NaN coordinates fail every comparison below, so test for them explicitly.
    if (!(x1 >= wx0 && x0 <= wx1 && y1 >= wy0 && y0 <= wy1)) continue
    // Clamped into the grid (no NaN is left here, only possibly infinities).
    let c0 = Math.floor((x0 - wx0) / cell)
    let r0 = Math.floor((y0 - wy0) / cell)
    let c1 = Math.floor((x1 - wx0) / cell)
    let r1 = Math.floor((y1 - wy0) / cell)
    c0 = c0 < 0 ? 0 : c0 > lastCol ? lastCol : c0
    r0 = r0 < 0 ? 0 : r0 > lastRow ? lastRow : r0
    c1 = c1 < 0 ? 0 : c1 > lastCol ? lastCol : c1
    r1 = r1 < 0 ? 0 : r1 > lastRow ? lastRow : r1
    const w = c1 - c0 + 1
    const h = r1 - r0 + 1
    if (w * h > MAX_EDGE_CELLS) {
      longList.push(e)
      continue
    }
    // An inverted box (x1 < x0) covers no cell.
    if (w <= 0 || h <= 0) continue
    const first = r0 * cols + c0
    edgeCell[e] = first
    edgeW[e] = w
    edgeH[e] = h
    for (let r = 0, row = first + 1; r < h; r++, row += cols) {
      for (let k = 0; k < w; k++) edgeStart[row + k]++
    }
  }
  for (let c = 0; c < cells; c++) edgeStart[c + 1] += edgeStart[c]
  const edgeItems = new Uint32Array(edgeStart[cells])
  const edgeFill = edgeStart.slice(0, cells)
  for (let e = 0; e < edgeCount; e++) {
    const w = edgeW[e]
    if (w === 0) continue
    const h = edgeH[e]
    for (let r = 0, row = edgeCell[e]; r < h; r++, row += cols) {
      for (let k = 0; k < w; k++) edgeItems[edgeFill[row + k]++] = e
    }
  }
  const longEdges = Uint32Array.from(longList)
  return { win: { ...win }, cell, cols, rows, nodeStart, nodeItems, edgeStart, edgeItems, longEdges }
}

/** Grids with more cells than this come back empty (see {@link buildGridTs}). */
const MAX_GRID_CELLS = 2 ** 26

function emptyGrid(win: GridWindow, cell: number): GridData {
  const none = new Uint32Array(0)
  return {
    win: { ...win },
    cell,
    cols: 1,
    rows: 1,
    nodeStart: new Uint32Array(2),
    nodeItems: none,
    edgeStart: new Uint32Array(2),
    edgeItems: none,
    longEdges: none,
  }
}

// ── Polyline simplification ────────────────────────────────────────────────────

/** Squared distance from `(x, y)` to the segment `a–b`. */
function segmentDistance2(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax
  const vy = by - ay
  const len2 = vx * vx + vy * vy
  let t = len2 === 0 ? 0 : ((x - ax) * vx + (y - ay) * vy) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = ax + t * vx - x
  const dy = ay + t * vy - y
  return dx * dx + dy * dy
}

export function simplifyPathsTs(
  xs: Float64Array,
  ys: Float64Array,
  starts: Uint32Array,
  ends: Uint32Array,
  count: number,
  tolerance: number,
  keep: Uint8Array,
): void {
  const tol2 = tolerance * tolerance
  let stack = new Int32Array(64)
  for (let e = 0; e < count; e++) {
    const s = starts[e]
    const t = ends[e]
    if (t <= s) continue
    if (t - s < 3) {
      for (let p = s; p < t; p++) keep[p] = 1
      continue
    }
    for (let p = s; p < t; p++) keep[p] = 0
    keep[s] = 1
    keep[t - 1] = 1
    // Iterative Douglas–Peucker: a stack of [first, last] index pairs.
    let top = 0
    stack[top++] = s
    stack[top++] = t - 1
    while (top > 0) {
      const last = stack[--top]
      const first = stack[--top]
      let maxD = -1
      let maxI = -1
      const ax = xs[first]
      const ay = ys[first]
      const bx = xs[last]
      const by = ys[last]
      for (let p = first + 1; p < last; p++) {
        const d = segmentDistance2(xs[p], ys[p], ax, ay, bx, by)
        if (d > maxD) {
          maxD = d
          maxI = p
        }
      }
      if (maxI >= 0 && maxD > tol2) {
        keep[maxI] = 1
        if (top + 4 > stack.length) {
          const next = new Int32Array(stack.length * 2)
          next.set(stack)
          stack = next
        }
        stack[top++] = first
        stack[top++] = maxI
        stack[top++] = maxI
        stack[top++] = last
      }
    }
  }
}

// ── The kernel set ─────────────────────────────────────────────────────────────

/** The pure TypeScript kernels: always available, no initialisation. */
export const tsKernels: Kernels = {
  name: 'ts',
  projectMercator: projectMercatorTs,
  createLod(geometry: LodGeometry): LodComputer {
    return {
      level: (zoom, cellPx) => computeLodLevelTs(geometry, zoom, cellPx),
      dispose: () => {},
    }
  },
  createGridBuilder(topology: GridTopology): GridBuilder {
    return {
      build: (positions, win, cell) => buildGridTs(topology, positions, win, cell),
      dispose: () => {},
    }
  },
  simplifyPaths: simplifyPathsTs,
  createSimplifier(xs, ys, starts, ends, count): Simplifier {
    return {
      simplify: (tolerance, keep) => simplifyPathsTs(xs, ys, starts, ends, count, tolerance, keep),
      dispose: () => {},
    }
  },
  clusterLevel: computeClusterLevelTs,
  createClusterer(unitX, unitY, nodeStyle, count, bounds): Clusterer {
    return {
      level: (zoom, cellPx) => computeClusterLevelTs(unitX, unitY, nodeStyle, count, zoom, cellPx, bounds),
      dispose: () => {},
    }
  },
}
