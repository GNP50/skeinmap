import { SceneBuilder, type Scene } from 'skeinmap'

/**
 * A synthetic, reproducible graph for the demo: nodes clustered around a few dozen made-up
 * cities spread over a continent-sized longitude/latitude box, local links to the nearest
 * neighbours inside each city, and a sparse long-range backbone between city hubs. Some
 * links follow a wiggly polyline instead of a straight line. Nothing here is real data.
 */

/** Node style bytes (indices into the demo's style table). */
export const NODE = { plain: 0, hub: 1, selected: 2, neighbour: 3, boxed: 4 } as const
/** Edge style bytes. */
export const EDGE = { local: 0, backbone: 1, route: 2, selected: 3 } as const

export interface City {
  name: string
  lon: number
  lat: number
  /** Index of the city's hub node. */
  hub: number
}

export interface SyntheticGraph {
  scene: Scene
  cities: City[]
  /** City of each node. */
  nodeCity: Uint16Array
  /** Number of links at each node. */
  degree: Uint32Array
  /** Index of each node within its city (for names like "Ostrava 1203"). */
  localIndex: Uint32Array
  /** Milliseconds spent building the scene. */
  buildMs: number
}

/** Longitude/latitude box the cities are spread over. */
const BOX = { lon0: -9, lon1: 31, lat0: 37, lat1: 58 }
const CITY_COUNT = 40
/** Nearest neighbours each node links to inside its city. */
const K = 3
/** Share of local links drawn along a wiggly polyline. */
const ROUTED_SHARE = 0.04

/** mulberry32: a small, fast, seedable PRNG. Same seed, same graph. */
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

const SYLLABLES = [
  'va',
  'ro',
  'ken',
  'del',
  'mar',
  'tis',
  'lo',
  'bre',
  'an',
  'sel',
  'or',
  'mi',
  'tu',
  'ga',
  'nor',
  'eth',
]

function cityName(random: () => number): string {
  const n = 2 + Math.floor(random() * 2)
  let s = ''
  for (let i = 0; i < n; i++) s += SYLLABLES[Math.floor(random() * SYLLABLES.length)]
  return s[0].toUpperCase() + s.slice(1)
}

/**
 * Build a graph of roughly `elements` nodes + edges. Edges come out at a little under twice
 * the node count, so about a third of the budget goes to nodes.
 */
export function buildSyntheticGraph(elements: number, seed = 7): SyntheticGraph {
  const t0 = performance.now()
  const random = rng(seed)
  const gauss = () => {
    // Box–Muller; 1 - random() keeps the log argument above zero.
    const u = 1 - random()
    const v = random()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }

  const nodeTotal = Math.max(CITY_COUNT * 4, Math.round(elements / 2.88))

  // Cities: positions, a Zipf-like weight for their size, a spread in degrees.
  const weights: number[] = []
  const cityDraft: { name: string; lon: number; lat: number; sigma: number }[] = []
  for (let c = 0; c < CITY_COUNT; c++) {
    const w = 1 / Math.pow(c + 1, 0.8)
    weights.push(w)
    cityDraft.push({
      name: cityName(random),
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
  const nodeCity = new Uint16Array(nodeCount)
  const localIndex = new Uint32Array(nodeCount)
  const cityStart = new Uint32Array(CITY_COUNT + 1)
  const cities: City[] = []

  let n = 0
  for (let c = 0; c < CITY_COUNT; c++) {
    const d = cityDraft[c]
    cityStart[c] = n
    cities.push({ name: d.name, lon: d.lon, lat: d.lat, hub: n })
    const lonScale = 1 / Math.cos((d.lat * Math.PI) / 180)
    for (let i = 0; i < counts[c]; i++, n++) {
      if (i === 0) {
        // The hub sits at the city centre.
        x[n] = d.lon
        y[n] = d.lat
      } else {
        // A dense core and wider outskirts.
        const s = random() < 0.85 ? d.sigma : d.sigma * 3
        x[n] = d.lon + gauss() * s * lonScale
        y[n] = d.lat + gauss() * s
      }
      nodeCity[n] = c
      localIndex[n] = i
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
    const cosLat = Math.cos((cityDraft[c].lat * Math.PI) / 180)
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
    // About four nodes per cell in the core.
    const cell = Math.max(1e-6, cityDraft[c].sigma * Math.sqrt(30 / count))
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
      // Rings of cells around the node until the K-th best is closer than the next ring.
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

  const builder = new SceneBuilder({ nodes: nodeCount, edges: nodeCount * 2.2, pathPoints: nodeCount / 3 })
  for (let i = 0; i < nodeCount; i++) builder.node(x[i], y[i], localIndex[i] === 0 ? NODE.hub : NODE.plain)

  const degree = new Uint32Array(nodeCount)
  const path = new Float64Array(2 * 64)
  /** A wiggly polyline from a to b with `m` points (endpoints included): a sine bend of
   *  `amp` times the length plus per-point jitter of `jitterAmp` times the length. */
  const wiggle = (ax: number, ay: number, bx: number, by: number, m: number, amp: number, jitterAmp: number) => {
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len
    const ny = dx / len
    const phase = random() * Math.PI * 2
    const waves = 1 + random() * 2
    for (let p = 0; p < m; p++) {
      const t = p / (m - 1)
      const bend =
        p === 0 || p === m - 1 ? 0 : Math.sin(t * Math.PI * waves + phase) * Math.sin(t * Math.PI) * amp * len
      const jitter = p === 0 || p === m - 1 ? 0 : (random() - 0.5) * jitterAmp * len
      path[2 * p] = ax + dx * t + nx * (bend + jitter)
      path[2 * p + 1] = ay + dy * t + ny * (bend + jitter)
    }
    return path.subarray(0, 2 * m)
  }

  // Local links, straight ones first, then the routed ones (fewer state changes on Canvas 2D).
  const routedFrom: number[] = []
  const routedTo: number[] = []
  for (let a = 0; a < nodeCount; a++) {
    for (let k = 0; k < K; k++) {
      const b = knn[a * K + k]
      if (b < 0) continue
      // Emitted once: when b < a and a is also among b's neighbours, b already did it.
      if (b < a && contains(b, a)) continue
      degree[a]++
      degree[b]++
      if (random() < ROUTED_SHARE) {
        routedFrom.push(a)
        routedTo.push(b)
      } else {
        builder.edge(a, b, EDGE.local)
      }
    }
  }
  for (let r = 0; r < routedFrom.length; r++) {
    const a = routedFrom[r]
    const b = routedTo[r]
    builder.edge(a, b, EDGE.route, wiggle(x[a], y[a], x[b], y[b], 3 + Math.floor(random() * 4), 0.25, 0.06))
  }

  // Backbone: each hub to its three nearest hubs, along long wiggly routes.
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
      const a = cities[c].hub
      const b = cities[j].hub
      degree[a]++
      degree[b]++
      builder.edge(a, b, EDGE.backbone, wiggle(x[a], y[a], x[b], y[b], 24 + Math.floor(random() * 24), 0.08, 0.008))
    }
  }

  const scene = builder.build()
  return { scene, cities, nodeCity, degree, localIndex, buildMs: performance.now() - t0 }
}

/** Great-circle distance in kilometres. */
export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}
