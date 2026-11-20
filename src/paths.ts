/**
 * Geometry helpers that produce edge paths for {@link SceneBuilder.edge}: curved edges
 * (so parallel edges between the same two nodes stay distinguishable) and great-circle
 * arcs for long-distance links on a map.
 *
 * Every helper returns a flat `[x0, y0, x1, y1, …]` array, the form `SceneBuilder.edge`
 * accepts as its `path` argument.
 *
 * @module
 */

const DEG = Math.PI / 180

/**
 * A quadratic Bézier curve from `a` to `b`, sampled as a flat `[x0, y0, x1, y1, …]`
 * polyline of `segments + 1` points whose first and last points are exactly `a` and `b`.
 *
 * The control point sits on the perpendicular bisector of the chord, offset by
 * `curvature × chord length` (so the curve's apex is half that distance from the chord).
 * A **positive** curvature bends the curve to the **left** of the direction a → b in a
 * frame where x grows to the right and y grows downwards (screen pixels, the standalone
 * pan/zoom view); a negative one bends it to the right. In a y-up frame (longitude /
 * latitude on a map) the sides are mirrored: positive bends to the right of a → b.
 *
 * A zero-length chord, a curvature of 0 or `segments < 2` gives the straight two-point
 * path `[ax, ay, bx, by]`.
 *
 * ```ts
 * const b = new SceneBuilder()
 * const u = b.node(0, 0)
 * const v = b.node(100, 0)
 * b.edge(u, v, 0, curvedPath(0, 0, 100, 0, 0.25)) // apex at (50, -12.5): above the chord on screen
 * ```
 *
 * @param curvature - Control-point offset as a fraction of the chord length (default 0.2).
 * @param segments - Number of straight segments in the polyline (default 16).
 */
export function curvedPath(ax: number, ay: number, bx: number, by: number, curvature = 0.2, segments = 16): number[] {
  const dx = bx - ax
  const dy = by - ay
  const n = Math.round(segments)
  if (!(Math.hypot(dx, dy) > 0) || !(n >= 2) || curvature === 0 || !Number.isFinite(curvature)) {
    return [ax, ay, bx, by]
  }
  // (dy, -dx) is the chord rotated a quarter turn to the left in a y-down frame; its
  // length is the chord length, so scaling it by `curvature` gives the requested offset.
  const cx = (ax + bx) / 2 + dy * curvature
  const cy = (ay + by) / 2 - dx * curvature
  const out = new Array<number>(2 * (n + 1))
  out[0] = ax
  out[1] = ay
  for (let i = 1; i < n; i++) {
    const t = i / n
    const u = 1 - t
    const w0 = u * u
    const w1 = 2 * u * t
    const w2 = t * t
    out[2 * i] = w0 * ax + w1 * cx + w2 * bx
    out[2 * i + 1] = w0 * ay + w1 * cy + w2 * by
  }
  out[2 * n] = bx
  out[2 * n + 1] = by
  return out
}

/**
 * The curvature to give the `index`-th of `count` parallel edges between the same two
 * nodes, for {@link curvedPath}: 0 for a single edge, otherwise a fan symmetric around
 * the straight line, `spread` apart — `(index - (count - 1) / 2) × spread`. With an odd
 * count the middle edge stays straight; with an even count none does.
 *
 * The sign of a curvature is relative to the direction a → b, so compute the paths of
 * all parallel edges in one canonical direction (for instance from the lower node index
 * to the higher one), even for edges stored the other way round.
 *
 * ```ts
 * // three links between u and v: curvatures -0.15, 0, 0.15
 * for (let i = 0; i < 3; i++) b.edge(u, v, 0, curvedPath(ux, uy, vx, vy, parallelCurvature(i, 3)))
 * ```
 *
 * @param spread - Curvature step between neighbouring edges (default 0.15).
 */
export function parallelCurvature(index: number, count: number, spread = 0.15): number {
  if (!(count > 1)) return 0
  return (index - (count - 1) / 2) * spread
}

/**
 * Points along the shortest great-circle arc between two longitude / latitude positions
 * (degrees), as a flat `[lon0, lat0, lon1, lat1, …]` array of `segments + 1` points,
 * interpolated with spherical linear interpolation on the unit sphere.
 *
 * Longitudes are kept continuous: consecutive points never differ by more than 180°, so
 * an arc that crosses the antimeridian goes past ±180 (for example 170 → 185 rather than
 * 170 → -175) and the polyline draws as one piece instead of a stroke across the world.
 * The first point is exactly `[lon1, lat1]`; the last is `[lon2 + k × 360, lat2]`, with
 * `k = 0` unless the arc crosses the antimeridian.
 *
 * Identical positions give the two-point path `[lon1, lat1, lon2, lat2]`. Antipodal
 * positions have no unique shortest arc: the arc then heads due north from the start
 * (through the North Pole).
 *
 * ```ts
 * // Milan → New York, drawn as a curved arc on a Mercator map
 * b.edge(milan, newYork, 0, greatCirclePath(9.19, 45.46, -74.01, 40.71))
 * ```
 *
 * @param segments - Number of straight segments in the polyline (default 32).
 */
export function greatCirclePath(lon1: number, lat1: number, lon2: number, lat2: number, segments = 32): number[] {
  const n = Math.max(1, Math.round(segments) || 1)
  const cl1 = Math.cos(lat1 * DEG)
  const ax = cl1 * Math.cos(lon1 * DEG)
  const ay = cl1 * Math.sin(lon1 * DEG)
  const az = Math.sin(lat1 * DEG)
  const cl2 = Math.cos(lat2 * DEG)
  const bx = cl2 * Math.cos(lon2 * DEG)
  const by = cl2 * Math.sin(lon2 * DEG)
  const bz = Math.sin(lat2 * DEG)
  const dot = Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz))
  // u: the unit vector in the plane of the arc, perpendicular to a, towards b.
  let ux = bx - dot * ax
  let uy = by - dot * ay
  let uz = bz - dot * az
  const ulen = Math.hypot(ux, uy, uz)
  let omega: number
  if (ulen < 1e-12) {
    if (dot > 0) return [lon1, lat1, lon2, lat2]
    // Antipodal: head north from a (the local north vector is always perpendicular to a).
    const sl1 = Math.sin(lat1 * DEG)
    ux = -sl1 * Math.cos(lon1 * DEG)
    uy = -sl1 * Math.sin(lon1 * DEG)
    uz = cl1
    const len = Math.hypot(ux, uy, uz)
    ux /= len
    uy /= len
    uz /= len
    omega = Math.PI
  } else {
    ux /= ulen
    uy /= ulen
    uz /= ulen
    omega = Math.atan2(ulen, dot)
  }
  const out = new Array<number>(2 * (n + 1))
  out[0] = lon1
  out[1] = lat1
  let prevLon = lon1
  for (let i = 1; i < n; i++) {
    const angle = (i / n) * omega
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    const x = c * ax + s * ux
    const y = c * ay + s * uy
    const z = c * az + s * uz
    const horizontal = Math.hypot(x, y)
    let lon = horizontal < 1e-12 ? prevLon : Math.atan2(y, x) / DEG
    lon = unwrap(lon, prevLon)
    out[2 * i] = lon
    out[2 * i + 1] = Math.atan2(z, horizontal) / DEG
    prevLon = lon
  }
  out[2 * n] = lon2 + 360 * Math.round((unwrap(lon2, prevLon) - lon2) / 360)
  out[2 * n + 1] = lat2
  return out
}

/** `lon` shifted by a multiple of 360 to lie within 180° of `ref`. */
function unwrap(lon: number, ref: number): number {
  return lon - 360 * Math.round((lon - ref) / 360)
}
