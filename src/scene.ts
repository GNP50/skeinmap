/**
 * A graph as flat typed arrays.
 *
 * Index `i` in the node arrays is one node; edges reference nodes by that index. Nothing
 * here knows what a node *means*: callers describe what to draw as an index into a small
 * style table ({@link SceneStyles}), and keep their own data in their own structures,
 * looked up by the same index when a node is picked or labelled.
 *
 * Coordinates are `x` / `y`. With a map adapter they are **longitude / latitude** in
 * degrees (GeoJSON order, not Leaflet's `[lat, lng]`); with the standalone pan/zoom view
 * they are plain world units.
 *
 * @module
 */

/** A node–link graph as flat arrays. See the module docs for the conventions. */
export interface Scene {
  nodeCount: number
  /** Longitude (map adapters) or world x (standalone view), one per node. */
  nodeX: Float64Array
  /** Latitude (map adapters) or world y (standalone view), one per node. */
  nodeY: Float64Array
  /** Index into {@link SceneStyles.nodes}, one per node (0–31), or {@link HIDDEN}. */
  nodeStyle: Uint8Array
  edgeCount: number
  /** Node index of each edge's first end. */
  edgeFrom: Uint32Array
  /** Node index of each edge's second end. */
  edgeTo: Uint32Array
  /** Index into {@link SceneStyles.edges}, one per edge (0–31), or {@link HIDDEN}. */
  edgeStyle: Uint8Array
  /**
   * Optional drawn geometry per edge (a polyline instead of the straight line between
   * its two nodes). Edge `e`'s points are `pathX/pathY[edgePathStart[e] .. edgePathEnd[e])`;
   * a range shorter than two points draws the straight line. Start/end rather than one
   * offsets array, so points need not be stored in edge order and a builder can reuse the
   * same point arrays across scenes whose edges were regrouped.
   */
  edgePathStart?: Uint32Array
  /** See {@link Scene.edgePathStart}. */
  edgePathEnd?: Uint32Array
  /** Path point x (longitude), see {@link Scene.edgePathStart}. */
  pathX?: Float64Array
  /** Path point y (latitude), see {@link Scene.edgePathStart}. */
  pathY?: Float64Array
  /**
   * Optional: the path points already in projected units (for a Mercator adapter,
   * {@link mercatorUnit} output). Adopted as-is when the adapter's projection matches,
   * so a builder that caches them spares the layer re-projecting every point per update.
   */
  pathUnitX?: Float64Array
  /** See {@link Scene.pathUnitX}. */
  pathUnitY?: Float64Array
  /**
   * Optional per-node colour, `0xRRGGBBAA` (see {@link rgba} and {@link packColor}). `0`
   * (or any colour with alpha 0) means "use the style's fill". The style still gives the
   * stroke. Rewrite in place and call `restyle()`.
   */
  nodeColor?: Uint32Array
  /** Optional per-node radius in CSS pixels; `0` means "use the style's radius". */
  nodeRadius?: Float32Array
  /** Optional per-edge colour, `0xRRGGBBAA`; `0` means "use the style's colour and opacity". */
  edgeColor?: Uint32Array
  /** Optional per-edge width in CSS pixels; `0` means "use the style's width". */
  edgeWidth?: Float32Array
}

/**
 * The style byte that hides an element: not drawn, not picked, not labelled, never kept
 * as a level-of-detail representative. The layer's filters write it into a copy of the
 * style bytes, so your scene keeps its own.
 */
export const HIDDEN = 255

/** A colour as `0xRRGGBBAA` from channels in 0–255 and alpha in 0–1. */
export function rgba(r: number, g: number, b: number, a = 1): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return ((c(r) << 24) | (c(g) << 16) | (c(b) << 8) | c(a * 255)) >>> 0
}

/** An empty scene — a convenient starting value. */
export function emptyScene(): Scene {
  return {
    nodeCount: 0,
    nodeX: new Float64Array(0),
    nodeY: new Float64Array(0),
    nodeStyle: new Uint8Array(0),
    edgeCount: 0,
    edgeFrom: new Uint32Array(0),
    edgeTo: new Uint32Array(0),
    edgeStyle: new Uint8Array(0),
  }
}

/** Whether edge `e` of `scene` is drawn along its own polyline (≥ 2 path points). */
export function isRouted(scene: Scene, e: number): boolean {
  const starts = scene.edgePathStart
  const ends = scene.edgePathEnd
  return starts !== undefined && ends !== undefined && ends[e] - starts[e] >= 2
}

/** `[minX, minY, maxX, maxY]` of a scene's nodes (and path points), or `null` when empty. */
export type Bounds = [number, number, number, number]

/** Bounding box of a scene's nodes and path points, or `null` for an empty scene. */
export function sceneBounds(scene: Scene): Bounds | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity
  const grow = (xs: Float64Array, ys: Float64Array, n: number) => {
    for (let i = 0; i < n; i++) {
      const x = xs[i]
      const y = ys[i]
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  grow(scene.nodeX, scene.nodeY, scene.nodeCount)
  if (scene.pathX && scene.pathY) grow(scene.pathX, scene.pathY, scene.pathX.length)
  return x0 === Infinity ? null : [x0, y0, x1, y1]
}

/** A growable typed array, so building a large scene does not go through boxed numbers. */
class Grow<T extends Float64Array | Uint32Array | Uint8Array> {
  data: T
  length = 0
  constructor(
    private readonly make: (n: number) => T,
    capacity: number,
  ) {
    this.data = make(Math.max(16, capacity))
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = this.make(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = v
  }
  freeze(): T {
    return this.data.slice(0, this.length) as T
  }
}

/** Capacity hints for {@link SceneBuilder}; growing past them is fine, just slower. */
export interface SceneBuilderOptions {
  nodes?: number
  edges?: number
  pathPoints?: number
}

/**
 * Grows typed arrays and freezes them into a {@link Scene}. Writes straight into typed
 * storage (doubling as needed), so a scene of a million elements builds without a
 * million boxed numbers.
 *
 * ```ts
 * const b = new SceneBuilder()
 * const a = b.node(9.19, 45.46, 0)      // x = longitude, y = latitude
 * const c = b.node(12.49, 41.9, 1)
 * b.edge(a, c, 0)
 * const scene = b.build()
 * ```
 */
export class SceneBuilder {
  private readonly x: Grow<Float64Array>
  private readonly y: Grow<Float64Array>
  private readonly nStyle: Grow<Uint8Array>
  private readonly from: Grow<Uint32Array>
  private readonly to: Grow<Uint32Array>
  private readonly eStyle: Grow<Uint8Array>
  private readonly pathStart: Grow<Uint32Array>
  private readonly pathEnd: Grow<Uint32Array>
  private readonly px: Grow<Float64Array>
  private readonly py: Grow<Float64Array>

  constructor(capacity: SceneBuilderOptions = {}) {
    const n = capacity.nodes ?? 64
    const e = capacity.edges ?? 64
    const p = capacity.pathPoints ?? 16
    const f64 = (k: number) => new Float64Array(k)
    const u32 = (k: number) => new Uint32Array(k)
    const u8 = (k: number) => new Uint8Array(k)
    this.x = new Grow(f64, n)
    this.y = new Grow(f64, n)
    this.nStyle = new Grow(u8, n)
    this.from = new Grow(u32, e)
    this.to = new Grow(u32, e)
    this.eStyle = new Grow(u8, e)
    this.pathStart = new Grow(u32, e)
    this.pathEnd = new Grow(u32, e)
    this.px = new Grow(f64, p)
    this.py = new Grow(f64, p)
  }

  /** Nodes added so far. */
  get nodeCount(): number {
    return this.x.length
  }

  /** Edges added so far. */
  get edgeCount(): number {
    return this.from.length
  }

  /** Add a node; returns its index, for use in {@link SceneBuilder.edge}. */
  node(x: number, y: number, style = 0): number {
    this.x.push(x)
    this.y.push(y)
    this.nStyle.push(style)
    return this.x.length - 1
  }

  /**
   * Add an edge between two node indices; returns its index. `path` — a flat
   * `[x0, y0, x1, y1, …]` array or `[[x, y], …]` pairs, at least two points — replaces
   * the straight line.
   */
  edge(
    from: number,
    to: number,
    style = 0,
    path?: ArrayLike<number> | readonly (readonly [number, number])[] | null,
  ): number {
    this.from.push(from)
    this.to.push(to)
    this.eStyle.push(style)
    this.pathStart.push(this.px.length)
    if (path && path.length > 0) {
      const first = (path as ArrayLike<unknown>)[0]
      if (typeof first === 'number') {
        const flat = path as ArrayLike<number>
        if (flat.length >= 4) {
          for (let k = 0; k + 1 < flat.length; k += 2) {
            this.px.push(flat[k])
            this.py.push(flat[k + 1])
          }
        }
      } else {
        const pairs = path as readonly (readonly [number, number])[]
        if (pairs.length >= 2) {
          for (const [px, py] of pairs) {
            this.px.push(px)
            this.py.push(py)
          }
        }
      }
    }
    this.pathEnd.push(this.px.length)
    return this.from.length - 1
  }

  /** Freeze into a {@link Scene}. The builder can keep growing afterwards. */
  build(): Scene {
    const scene: Scene = {
      nodeCount: this.x.length,
      nodeX: this.x.freeze(),
      nodeY: this.y.freeze(),
      nodeStyle: this.nStyle.freeze(),
      edgeCount: this.from.length,
      edgeFrom: this.from.freeze(),
      edgeTo: this.to.freeze(),
      edgeStyle: this.eStyle.freeze(),
    }
    if (this.px.length > 0) {
      scene.edgePathStart = this.pathStart.freeze()
      scene.edgePathEnd = this.pathEnd.freeze()
      scene.pathX = this.px.freeze()
      scene.pathY = this.py.freeze()
    }
    return scene
  }
}

/**
 * Check a scene's invariants (array lengths, node indices in range, path ranges inside
 * the point arrays, style bytes below 32). Returns a list of problems, empty when valid.
 * Meant for development and tests — the layer itself does not validate on every update.
 */
export function validateScene(scene: Scene): string[] {
  const problems: string[] = []
  const { nodeCount: n, edgeCount: m } = scene
  if (scene.nodeX.length < n || scene.nodeY.length < n || scene.nodeStyle.length < n) {
    problems.push('node arrays are shorter than nodeCount')
  }
  if (scene.edgeFrom.length < m || scene.edgeTo.length < m || scene.edgeStyle.length < m) {
    problems.push('edge arrays are shorter than edgeCount')
  }
  for (let i = 0; i < Math.min(n, scene.nodeStyle.length); i++) {
    if (scene.nodeStyle[i] > 31 && scene.nodeStyle[i] !== HIDDEN) {
      problems.push(`node ${i}: style ${scene.nodeStyle[i]} is above 31`)
      break
    }
  }
  for (let e = 0; e < Math.min(m, scene.edgeFrom.length, scene.edgeTo.length); e++) {
    if (scene.edgeFrom[e] >= n || scene.edgeTo[e] >= n) {
      problems.push(`edge ${e}: node index out of range`)
      break
    }
  }
  for (let e = 0; e < Math.min(m, scene.edgeStyle.length); e++) {
    if (scene.edgeStyle[e] > 31 && scene.edgeStyle[e] !== HIDDEN) {
      problems.push(`edge ${e}: style ${scene.edgeStyle[e]} is above 31`)
      break
    }
  }
  const { edgePathStart: s, edgePathEnd: t, pathX, pathY } = scene
  if (s || t || pathX || pathY) {
    if (!s || !t || !pathX || !pathY) problems.push('path arrays must be given together')
    else {
      if (s.length < m || t.length < m) problems.push('edgePathStart/End are shorter than edgeCount')
      if (pathX.length !== pathY.length) problems.push('pathX and pathY differ in length')
      for (let e = 0; e < Math.min(m, s.length, t.length); e++) {
        if (s[e] > t[e] || t[e] > pathX.length) {
          problems.push(`edge ${e}: path range [${s[e]}, ${t[e]}) is outside the point arrays`)
          break
        }
      }
    }
  }
  for (const [name, arr, len] of [
    ['nodeColor', scene.nodeColor, n],
    ['nodeRadius', scene.nodeRadius, n],
    ['edgeColor', scene.edgeColor, m],
    ['edgeWidth', scene.edgeWidth, m],
  ] as const) {
    if (arr && arr.length < len) problems.push(`${name} is shorter than the element count`)
  }
  return problems
}
