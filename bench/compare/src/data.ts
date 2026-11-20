/**
 * The dataset every page draws: a seeded, synthetic node–link graph, adapted from the
 * skeinmap demo generator (`examples/demo/synthetic.ts`) without its dependency on
 * skeinmap and with straight edges only, so every library draws exactly the same thing.
 *
 * Nodes are clustered around 40 made-up cities in a continent-sized longitude/latitude
 * box; each node links to its 3 nearest neighbours inside its city, and each city hub to
 * the 3 nearest hubs. Nothing here is real data. Same `elements` and `seed`, same graph.
 */

export interface Graph {
  nodeCount: number
  edgeCount: number
  /** Longitude and latitude of each node, in degrees. */
  lon: Float64Array
  lat: Float64Array
  /** Edge endpoints (node indices). */
  from: Uint32Array
  to: Uint32Array
  /** [minLon, minLat, maxLon, maxLat] over all nodes. */
  bounds: [number, number, number, number]
}

const BOX = { lon0: -9, lon1: 31, lat0: 37, lat1: 58 }
const CITY_COUNT = 40
const K = 3

/** mulberry32: a small, fast, seedable PRNG (the same one the demo uses). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A graph of roughly `elements` nodes + edges (edges come out at ~1.9 × the nodes). */
export function buildGraph(elements: number, seed = 7): Graph {
  const random = rng(seed)
  const gauss = () => {
    const u = 1 - random()
    const v = random()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  const nodeTotal = Math.max(CITY_COUNT * 4, Math.round(elements / 2.88))

  const weights: number[] = []
  const cities: { lon: number; lat: number; sigma: number }[] = []
  for (let c = 0; c < CITY_COUNT; c++) {
    const w = 1 / Math.pow(c + 1, 0.8)
    weights.push(w)
    cities.push({
      lon: BOX.lon0 + random() * (BOX.lon1 - BOX.lon0),
      lat: BOX.lat0 + random() * (BOX.lat1 - BOX.lat0),
      sigma: 0.12 + 0.55 * Math.sqrt(w),
    })
  }
  const weightSum = weights.reduce((a, b) => a + b, 0)
  const counts = weights.map((w) => Math.max(4, Math.round((w / weightSum) * nodeTotal)))
  const nodeCount = counts.reduce((a, b) => a + b, 0)

  const x = new Float64Array(nodeCount)
  const y = new Float64Array(nodeCount)
  const cityStart = new Uint32Array(CITY_COUNT + 1)
  const hubs: number[] = []
  let n = 0
  for (let c = 0; c < CITY_COUNT; c++) {
    const d = cities[c]
    cityStart[c] = n
    hubs.push(n)
    const lonScale = 1 / Math.cos((d.lat * Math.PI) / 180)
    for (let i = 0; i < counts[c]; i++, n++) {
      if (i === 0) {
        x[n] = d.lon
        y[n] = d.lat
      } else {
        const s = random() < 0.85 ? d.sigma : d.sigma * 3
        x[n] = d.lon + gauss() * s * lonScale
        y[n] = d.lat + gauss() * s
      }
    }
  }
  cityStart[CITY_COUNT] = n

  // K nearest neighbours inside each city, on a per-city uniform grid.
  const knn = new Int32Array(nodeCount * K).fill(-1)
  let cellStart = new Uint32Array(0)
  let cellItems = new Uint32Array(0)
  for (let c = 0; c < CITY_COUNT; c++) {
    const lo = cityStart[c]
    const hi = cityStart[c + 1]
    const count = hi - lo
    const cosLat = Math.cos((cities[c].lat * Math.PI) / 180)
    let bx0 = Infinity,
      by0 = Infinity,
      bx1 = -Infinity,
      by1 = -Infinity
    for (let i = lo; i < hi; i++) {
      const px = x[i] * cosLat
      if (px < bx0) bx0 = px
      if (px > bx1) bx1 = px
      if (y[i] < by0) by0 = y[i]
      if (y[i] > by1) by1 = y[i]
    }
    const cell = Math.max(1e-6, cities[c].sigma * Math.sqrt(30 / count))
    const cols = Math.min(2048, Math.floor((bx1 - bx0) / cell) + 1)
    const rows = Math.min(2048, Math.floor((by1 - by0) / cell) + 1)
    const cw = (bx1 - bx0) / cols || cell
    const ch = (by1 - by0) / rows || cell
    const cellCount = cols * rows
    if (cellStart.length < cellCount + 1) cellStart = new Uint32Array(cellCount + 1)
    else cellStart.fill(0, 0, cellCount + 1)
    if (cellItems.length < count) cellItems = new Uint32Array(count)
    const colOf = (i: number) => Math.min(cols - 1, Math.floor((x[i] * cosLat - bx0) / cw))
    const rowOf = (i: number) => Math.min(rows - 1, Math.floor((y[i] - by0) / ch))
    for (let i = lo; i < hi; i++) cellStart[rowOf(i) * cols + colOf(i) + 1]++
    for (let k = 0; k < cellCount; k++) cellStart[k + 1] += cellStart[k]
    const fill = cellStart.slice(0, cellCount)
    for (let i = lo; i < hi; i++) cellItems[fill[rowOf(i) * cols + colOf(i)]++] = i

    const bestD = new Float64Array(K)
    const bestI = new Int32Array(K)
    for (let i = lo; i < hi; i++) {
      bestD.fill(Infinity)
      bestI.fill(-1)
      const ci = colOf(i)
      const ri = rowOf(i)
      const px = x[i] * cosLat
      const py = y[i]
      const visit = (cx: number, cy: number) => {
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return
        const cc = cy * cols + cx
        for (let k = cellStart[cc]; k < cellStart[cc + 1]; k++) {
          const j = cellItems[k]
          if (j === i) continue
          const dx = x[j] * cosLat - px
          const dy = y[j] - py
          const d2 = dx * dx + dy * dy
          if (d2 >= bestD[K - 1]) continue
          let p = K - 1
          while (p > 0 && bestD[p - 1] > d2) {
            bestD[p] = bestD[p - 1]
            bestI[p] = bestI[p - 1]
            p--
          }
          bestD[p] = d2
          bestI[p] = j
        }
      }
      for (let r = 0; r < 40; r++) {
        if (r === 0) visit(ci, ri)
        else {
          for (let d = -r; d <= r; d++) {
            visit(ci + d, ri - r)
            visit(ci + d, ri + r)
          }
          for (let d = -r + 1; d <= r - 1; d++) {
            visit(ci - r, ri + d)
            visit(ci + r, ri + d)
          }
        }
        const reach = r * Math.min(cw, ch)
        if (bestI[K - 1] >= 0 && bestD[K - 1] <= reach * reach) break
      }
      for (let k = 0; k < K; k++) knn[i * K + k] = bestI[k]
    }
  }

  const contains = (a: number, b: number) => {
    for (let k = 0; k < K; k++) if (knn[a * K + k] === b) return true
    return false
  }

  let from = new Uint32Array(Math.ceil(nodeCount * 2.2))
  let to = new Uint32Array(from.length)
  let e = 0
  const push = (a: number, b: number) => {
    if (e === from.length) {
      const f2 = new Uint32Array(from.length * 2)
      const t2 = new Uint32Array(from.length * 2)
      f2.set(from)
      t2.set(to)
      from = f2
      to = t2
    }
    from[e] = a
    to[e] = b
    e++
  }
  for (let a = 0; a < nodeCount; a++) {
    for (let k = 0; k < K; k++) {
      const b = knn[a * K + k]
      if (b < 0) continue
      if (b < a && contains(b, a)) continue
      push(a, b)
    }
  }
  // Backbone: each hub to its three nearest hubs (straight here).
  const seen = new Set<number>()
  for (let c = 0; c < CITY_COUNT; c++) {
    const order = cities
      .map((o, j) => ({ j, d: Math.hypot((o.lon - cities[c].lon) * 0.7, o.lat - cities[c].lat) }))
      .filter((o) => o.j !== c)
      .sort((p, q) => p.d - q.d)
      .slice(0, 3)
    for (const { j } of order) {
      const key = Math.min(c, j) * CITY_COUNT + Math.max(c, j)
      if (seen.has(key)) continue
      seen.add(key)
      push(hubs[c], hubs[j])
    }
  }

  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity
  for (let i = 0; i < nodeCount; i++) {
    if (x[i] < minLon) minLon = x[i]
    if (x[i] > maxLon) maxLon = x[i]
    if (y[i] < minLat) minLat = y[i]
    if (y[i] > maxLat) maxLat = y[i]
  }
  return {
    nodeCount,
    edgeCount: e,
    lon: x,
    lat: y,
    from: from.slice(0, e),
    to: to.slice(0, e),
    bounds: [minLon, minLat, maxLon, maxLat],
  }
}
