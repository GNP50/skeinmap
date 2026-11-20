import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initWasm, kernels, setKernelPreference, tsKernels, wasmStatus } from '../src/kernels/index'
import type { ClusterLevel, GridData, GridWindow, Kernels, LodGeometry } from '../src/kernels/types'

// The WebAssembly kernels must produce exactly what the TypeScript kernels produce:
// identical integer outputs (kept nodes, segments, grid rows, keep masks) and Mercator
// within an ulp-level tolerance (the two sides use different libm implementations).

/** Small seeded PRNG (mulberry32): uniform in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SIZES = [0, 1, 1000, 50_000]
const ZOOMS = [0, 5, 10, 15]

let wasm: Kernels

beforeAll(async () => {
  const bytes = readFileSync(new URL('../src/wasm/pkg/skeinmap_wasm_bg.wasm', import.meta.url))
  await expect(initWasm(bytes)).resolves.toBe(true)
  setKernelPreference('auto')
  wasm = kernels()
})

afterAll(() => setKernelPreference('auto'))

describe('loading', () => {
  it('activates the WebAssembly kernels', () => {
    expect(wasmStatus()).toBe('ready')
    expect(wasm.name).toBe('wasm')
    expect(kernels().name).toBe('wasm')
  })

  it('falls back to TypeScript when asked to', () => {
    setKernelPreference('ts')
    expect(kernels().name).toBe('ts')
    setKernelPreference('wasm')
    expect(kernels().name).toBe('wasm')
    setKernelPreference('auto')
    expect(kernels().name).toBe('wasm')
  })
})

// ── Synthetic data ─────────────────────────────────────────────────────────────

type Bounds = [number, number, number, number]

/**
 * A clustered scene inside `bounds`: coincident points, tight clusters at several scales,
 * scattered points, a few NaN and out-of-bounds positions, styles 0–255 (so `& 31`
 * matters), and routed edges with paths of every length (some points NaN or repeated).
 */
function makeGeometry(n: number, seed: number, bounds?: Bounds): LodGeometry {
  const rnd = mulberry32(seed)
  const [bx0, by0, bx1, by1] = bounds ?? [0, 0, 256, 256]
  const w = bx1 - bx0
  const h = by1 - by0
  const unitX = new Float64Array(n)
  const unitY = new Float64Array(n)
  const nodeStyle = new Uint8Array(n)
  const centres = Array.from({ length: Math.max(1, n >> 6) }, () => [bx0 + rnd() * w, by0 + rnd() * h])
  for (let i = 0; i < n; i++) {
    const r = rnd()
    if (r < 0.1 && i > 0) {
      const j = Math.floor(rnd() * i) // coincident with an earlier node
      unitX[i] = unitX[j]
      unitY[i] = unitY[j]
    } else if (r < 0.8) {
      const [cx, cy] = centres[Math.floor(rnd() * centres.length)]
      const spread = w * Math.pow(10, -1 - rnd() * 6)
      unitX[i] = cx + (rnd() - 0.5) * spread
      unitY[i] = cy + (rnd() - 0.5) * spread
    } else if (r < 0.995) {
      unitX[i] = bx0 + rnd() * w
      unitY[i] = by0 + rnd() * h
    } else if (r < 0.998) {
      unitX[i] = rnd() < 0.5 ? NaN : bx0 + rnd() * w
      unitY[i] = Number.isNaN(unitX[i]) && rnd() < 0.5 ? by0 : NaN
    } else {
      unitX[i] = bx0 - w * rnd() // outside the bounds
      unitY[i] = by1 + h * rnd()
    }
    nodeStyle[i] = rnd() < 0.7 ? Math.floor(rnd() * 32) : Math.floor(rnd() * 256)
  }

  const m = Math.floor(n * 1.5)
  const edgeFrom = new Uint32Array(m)
  const edgeTo = new Uint32Array(m)
  const edgeStyle = new Uint8Array(m)
  const edgePathStart = new Uint32Array(m)
  const edgePathEnd = new Uint32Array(m)
  const px: number[] = []
  const py: number[] = []
  for (let e = 0; e < m; e++) {
    const a = Math.floor(rnd() * n)
    // Mostly local edges (which LOD drops or deduplicates), some long ones.
    const b = rnd() < 0.7 ? Math.min(n - 1, a + Math.floor(rnd() * 8)) : Math.floor(rnd() * n)
    edgeFrom[e] = a
    edgeTo[e] = b
    edgeStyle[e] = rnd() < 0.8 ? Math.floor(rnd() * 4) : Math.floor(rnd() * 256)
    edgePathStart[e] = px.length
    if (rnd() < 0.2) {
      // A routed edge: a random walk from a to b with 0–40 points.
      const k = Math.floor(rnd() * 41)
      const step = w * Math.pow(10, -2 - rnd() * 5)
      let x = unitX[a]
      let y = unitY[a]
      for (let p = 0; p < k; p++) {
        const r = rnd()
        if (r < 0.15 && p > 0) {
          // repeat the previous point
        } else if (r < 0.17) {
          x = NaN
        } else {
          if (Number.isNaN(x)) x = unitX[b]
          if (Number.isNaN(y)) y = unitY[b]
          x += (rnd() - 0.5) * step
          y += (rnd() - 0.5) * step
        }
        px.push(x)
        py.push(y)
      }
    }
    edgePathEnd[e] = px.length
  }
  return {
    nodeCount: n,
    unitX,
    unitY,
    nodeStyle,
    edgeCount: m,
    edgeFrom,
    edgeTo,
    edgeStyle,
    edgePathStart,
    edgePathEnd,
    unitPX: Float64Array.from(px),
    unitPY: Float64Array.from(py),
    bounds,
  }
}

function withoutPaths(g: LodGeometry): LodGeometry {
  return { ...g, edgePathStart: undefined, edgePathEnd: undefined, unitPX: undefined, unitPY: undefined }
}

/** `g` with about `share` of its nodes and edges hidden (style 255). */
function withHidden(g: LodGeometry, seed: number, share = 0.15): LodGeometry {
  const rnd = mulberry32(seed)
  const nodeStyle = g.nodeStyle.map((s) => (rnd() < share ? 255 : s))
  const edgeStyle = g.edgeStyle.map((s) => (rnd() < share ? 255 : s))
  return { ...g, nodeStyle, edgeStyle }
}

// ── Projection ─────────────────────────────────────────────────────────────────

describe('projectMercator', () => {
  for (const n of SIZES) {
    it(`agrees within 1e-9 for ${n} points`, () => {
      const rnd = mulberry32(1000 + n)
      const xs = Float64Array.from({ length: n }, () => (rnd() - 0.5) * 400)
      const ys = Float64Array.from({ length: n }, () => (rnd() - 0.5) * 200)
      const special = [NaN, Infinity, -Infinity, 0, -0, 85.0511287798, -85.0511287798, 90, -90]
      for (let i = 0, k = 0; i < n; i += 97, k++) ys[i] = special[k % special.length]
      for (let i = 13, k = 0; i < n; i += 211, k++) xs[i] = special[k % 3]
      const tsX = new Float64Array(n + 2).fill(7)
      const tsY = new Float64Array(n + 2).fill(7)
      const wX = new Float64Array(n + 2).fill(7)
      const wY = new Float64Array(n + 2).fill(7)
      tsKernels.projectMercator(xs, ys, tsX, tsY, n)
      wasm.projectMercator(xs, ys, wX, wY, n)
      for (const [a, b] of [
        [tsX, wX],
        [tsY, wY],
      ]) {
        for (let i = 0; i < n + 2; i++) {
          if (Number.isNaN(a[i]) || !Number.isFinite(a[i])) expect(b[i]).toBe(a[i])
          else if (Math.abs(a[i] - b[i]) > 1e-9) expect(b[i]).toBe(a[i])
        }
      }
      expect(wX[n]).toBe(7)
    })
  }

  it('writes only `count` points of longer arrays', () => {
    const xs = Float64Array.of(10, 20, 30)
    const ys = Float64Array.of(10, 20, 30)
    const ox = new Float64Array(3).fill(7)
    const oy = new Float64Array(3).fill(7)
    wasm.projectMercator(xs, ys, ox, oy, 2)
    expect(ox[2]).toBe(7)
    expect(oy[2]).toBe(7)
    expect(ox[1]).toBeCloseTo(256 * (0.5 + 20 / 360), 12)
  })
})

// ── Level of detail ────────────────────────────────────────────────────────────

describe('LOD', () => {
  const boundsCases: [string, Bounds | undefined][] = [
    ['Mercator bounds', undefined],
    ['custom bounds', [-1234.5, -321.25, 765.5, 1678.75]],
  ]
  for (const [label, bounds] of boundsCases) {
    for (const n of SIZES) {
      it(`matches exactly: ${n} nodes, ${label}, routed and straight, with and without hidden elements`, () => {
        const g = makeGeometry(n, 17 + n, bounds)
        const hidden = withHidden(g, 23 + n)
        for (const geom of [g, withoutPaths(g), hidden, withoutPaths(hidden)]) {
          const a = tsKernels.createLod(geom)
          const b = wasm.createLod(geom)
          try {
            for (const zoom of ZOOMS) {
              for (const cellPx of [2, 6.5]) {
                const want = a.level(zoom, cellPx)
                const got = b.level(zoom, cellPx)
                expect(got.zoom).toBe(zoom)
                expect(got.nodes).toEqual(want.nodes)
                expect(got.segEdge).toEqual(want.segEdge)
                expect(got.segP0).toEqual(want.segP0)
                expect(got.segP1).toEqual(want.segP1)
              }
            }
          } finally {
            a.dispose()
            b.dispose()
          }
        }
      })
    }
  }

  it('deduplicates on the 50 000-node scene (the test data is not trivial)', () => {
    const g = makeGeometry(50_000, 99)
    const level = tsKernels.createLod(g).level(5)
    expect(level.nodes.length).toBeGreaterThan(1000)
    expect(level.nodes.length).toBeLessThan(45_000)
    let routed = 0
    for (let s = 0; s < level.segP0.length; s++) if (level.segP0[s] >= 0) routed++
    expect(routed).toBeGreaterThan(100)
    expect(level.segEdge.length - routed).toBeGreaterThan(100)
  })

  it('hides elements on the test data (style 255 changes the output)', () => {
    const g = makeGeometry(50_000, 99)
    const h = withHidden(g, 7)
    const a = tsKernels.createLod(g).level(5)
    const b = tsKernels.createLod(h).level(5)
    const b2 = wasm.createLod(h).level(5)
    expect(b2).toEqual(b)
    expect(b.nodes.length).not.toBe(a.nodes.length)
    for (const i of b.nodes) expect(h.nodeStyle[i]).not.toBe(255)
    for (const e of b.segEdge) expect(h.edgeStyle[e]).not.toBe(255)
  })

  it('reuses one geometry across many levels and refuses use after dispose', () => {
    const g = makeGeometry(1000, 5)
    const lod = wasm.createLod(g)
    const first = lod.level(7)
    expect(lod.level(7)).toEqual(first)
    expect(first).toEqual(tsKernels.createLod(g).level(7))
    lod.dispose()
    lod.dispose()
    expect(() => lod.level(7)).toThrow()
  })
})

// ── Clustering ─────────────────────────────────────────────────────────────────

function expectSameClusters(got: ClusterLevel, want: ClusterLevel): void {
  expect(got.zoom).toBe(want.zoom)
  expect(got.clusterOf).toEqual(want.clusterOf)
  expect(got.count).toEqual(want.count)
  // Bit-identical centroids (toEqual would also accept NaN for NaN, and -0 for 0).
  expect(got.x.length).toBe(want.x.length)
  for (let k = 0; k < want.x.length; k++) {
    if (!Object.is(got.x[k], want.x[k])) expect(got.x[k]).toBe(want.x[k])
    if (!Object.is(got.y[k], want.y[k])) expect(got.y[k]).toBe(want.y[k])
  }
}

describe('clustering', () => {
  const boundsCases: [string, Bounds | undefined][] = [
    ['Mercator bounds', undefined],
    ['custom bounds', [-1234.5, -321.25, 765.5, 1678.75]],
  ]
  for (const [label, bounds] of boundsCases) {
    for (const n of SIZES) {
      it(`matches exactly: ${n} nodes, ${label}, with and without hidden nodes`, () => {
        const g = makeGeometry(n, 41 + n, bounds)
        for (const geom of [g, withHidden(g, 43 + n)]) {
          const a = tsKernels.createClusterer(geom.unitX, geom.unitY, geom.nodeStyle, n, bounds)
          const b = wasm.createClusterer(geom.unitX, geom.unitY, geom.nodeStyle, n, bounds)
          try {
            for (const zoom of [...ZOOMS, 6]) {
              for (const cellPx of [undefined, 2, 6.5, 60]) {
                const want = a.level(zoom, cellPx)
                expectSameClusters(b.level(zoom, cellPx), want)
                expectSameClusters(
                  wasm.clusterLevel(geom.unitX, geom.unitY, geom.nodeStyle, n, zoom, cellPx, bounds),
                  want,
                )
              }
            }
          } finally {
            a.dispose()
            b.dispose()
          }
        }
      })
    }
  }

  it('clusters the test data at z6 (not trivially)', () => {
    const g = withHidden(makeGeometry(50_000, 99), 3)
    const level = tsKernels.clusterLevel(g.unitX, g.unitY, g.nodeStyle, 50_000, 6)
    expect(level.count.length).toBeGreaterThan(100)
    expect(level.count.length).toBeLessThan(20_000)
    let max = 0
    for (const c of level.count) max = Math.max(max, c)
    expect(max).toBeGreaterThan(50)
    expect(level.clusterOf.filter((c) => c === 0xffffffff).length).toBeGreaterThan(1000)
  })

  it('agrees on special values and on a count past the arrays', () => {
    const xs = Float64Array.of(0, -0, Infinity, -Infinity, NaN, 1e300, -1e300, 5, 5, 5)
    const ys = Float64Array.of(-0, 0, 1, Infinity, 1, 1e300, 0, -Infinity, NaN, 5)
    const styles = Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 255, 254)
    for (const count of [10, 13]) {
      for (const zoom of [0, 7, -3, 30]) {
        expectSameClusters(
          wasm.clusterLevel(xs, ys, styles, count, zoom, 60, [0, 0, 256, 256]),
          tsKernels.clusterLevel(xs, ys, styles, count, zoom, 60, [0, 0, 256, 256]),
        )
      }
    }
  })

  it('captures the positions when created and refuses use after dispose', () => {
    const g = makeGeometry(1000, 8)
    const ux = g.unitX.slice()
    const c = wasm.createClusterer(ux, g.unitY, g.nodeStyle, 1000)
    const want = tsKernels.clusterLevel(g.unitX, g.unitY, g.nodeStyle, 1000, 6)
    ux.fill(0)
    expectSameClusters(c.level(6), want)
    c.dispose()
    c.dispose()
    expect(() => c.level(6)).toThrow()
  })
})

// ── Hit-test grid ──────────────────────────────────────────────────────────────

function makeGridCase(n: number, seed: number) {
  const g = makeGeometry(n, seed)
  const rnd = mulberry32(seed + 1)
  // Absolute pixels at zoom 8: positions × 256.
  const projX = g.unitX.map((v) => v * 256)
  const projY = g.unitY.map((v) => v * 256)
  const m = g.edgeCount
  const edgeBox = new Float64Array(m * 4).fill(NaN)
  for (let e = 0; e < m; e++) {
    const s = g.edgePathStart![e]
    const t = g.edgePathEnd![e]
    if (t - s < 2) continue
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let p = s; p < t; p++) {
      x0 = Math.min(x0, g.unitPX![p] * 256)
      x1 = Math.max(x1, g.unitPX![p] * 256)
      y0 = Math.min(y0, g.unitPY![p] * 256)
      y1 = Math.max(y1, g.unitPY![p] * 256)
    }
    edgeBox.set([x0, y0, x1, y1], e * 4)
    if (rnd() < 0.02) edgeBox[e * 4 + 1 + Math.floor(rnd() * 3)] = NaN
  }
  return { g, projX, projY, edgeBox }
}

function expectSameGrid(got: GridData, want: GridData): void {
  expect([got.cols, got.rows, got.cell]).toEqual([want.cols, want.rows, want.cell])
  expect(got.win).toEqual(want.win)
  expect(got.nodeStart).toEqual(want.nodeStart)
  expect(got.nodeItems).toEqual(want.nodeItems)
  expect(got.edgeStart).toEqual(want.edgeStart)
  expect(got.edgeItems).toEqual(want.edgeItems)
  expect(got.longEdges).toEqual(want.longEdges)
}

describe('grid', () => {
  const windows: [GridWindow, number][] = [
    [{ x0: 0, y0: 0, x1: 65536, y1: 65536 }, 4096], // the whole world, 16 × 16
    [{ x0: 20000.25, y0: 30000.5, x1: 22000.75, y1: 31500 }, 32], // a viewport plus margin
    [{ x0: 31000, y0: 33000, x1: 31100, y1: 33100 }, 3.7], // a small window, fractional cell
    [{ x0: -552, y0: 0, x1: 528, y1: 80 }, 40], // a window whose last column rounds
  ]
  for (const n of SIZES) {
    it(`matches exactly: ${n} nodes, with and without edge boxes`, () => {
      const { g, projX, projY, edgeBox } = makeGridCase(n, 300 + n)
      const topo = { nodeCount: n, edgeCount: g.edgeCount, edgeFrom: g.edgeFrom, edgeTo: g.edgeTo }
      const a = tsKernels.createGridBuilder(topo)
      const b = wasm.createGridBuilder(topo)
      try {
        for (const [win, cell] of windows) {
          for (const box of [undefined, edgeBox]) {
            const pos = { projX, projY, edgeBox: box }
            expectSameGrid(b.build(pos, win, cell), a.build(pos, win, cell))
          }
        }
      } finally {
        a.dispose()
        b.dispose()
      }
    })
  }

  it('produces long edges and gridded edges on the test data', () => {
    const { g, projX, projY, edgeBox } = makeGridCase(50_000, 350)
    const topo = { nodeCount: 50_000, edgeCount: g.edgeCount, edgeFrom: g.edgeFrom, edgeTo: g.edgeTo }
    const grid = tsKernels.createGridBuilder(topo).build({ projX, projY, edgeBox }, windows[1][0], windows[1][1])
    expect(grid.longEdges.length).toBeGreaterThan(10)
    expect(grid.edgeItems.length).toBeGreaterThan(10)
    expect(grid.nodeItems.length).toBeGreaterThan(10)
  })

  it('agrees on a node at the rounding edge of the last column', () => {
    const topo = { nodeCount: 2, edgeCount: 1, edgeFrom: Uint32Array.of(0), edgeTo: Uint32Array.of(1) }
    const pos = { projX: Float64Array.of(527.9999999999999, -552), projY: Float64Array.of(0.5, 79) }
    const win = { x0: -552, y0: 0, x1: 528, y1: 80 }
    const want = tsKernels.createGridBuilder(topo).build(pos, win, 40)
    expectSameGrid(wasm.createGridBuilder(topo).build(pos, win, 40), want)
    expect(want.nodeItems.length).toBe(2)
  })

  it('agrees on degenerate windows and cells', () => {
    const { g, projX, projY } = makeGridCase(1000, 77)
    const topo = { nodeCount: 1000, edgeCount: g.edgeCount, edgeFrom: g.edgeFrom, edgeTo: g.edgeTo }
    const cases: [GridWindow, number][] = [
      [{ x0: 30000, y0: 30000, x1: 30000, y1: 31000 }, 10], // zero width
      [{ x0: 31000, y0: 30000, x1: 30000, y1: 31000 }, 10], // inverted
      [{ x0: 0, y0: 0, x1: 65536, y1: 65536 }, Infinity],
      [{ x0: NaN, y0: 0, x1: 100, y1: 100 }, 10],
      [{ x0: 0, y0: 0, x1: Infinity, y1: 100 }, 10],
      [{ x0: 0, y0: 0, x1: 100, y1: 100 }, 0],
      [{ x0: 0, y0: 0, x1: 100, y1: 100 }, -5],
      [{ x0: 0, y0: 0, x1: 1e6, y1: 1e6 }, 0.01],
    ]
    for (const [win, cell] of cases) {
      expectSameGrid(
        wasm.createGridBuilder(topo).build({ projX, projY }, win, cell),
        tsKernels.createGridBuilder(topo).build({ projX, projY }, win, cell),
      )
    }
  })
})

// ── Polyline simplification ────────────────────────────────────────────────────

/**
 * `n` polylines of 0–60 points (straight, coincident or wiggly; a few NaN points) after
 * two points outside every range. With `gaps`, some points between ranges belong to no
 * range and some ranges are empty; without, the ranges are packed one after another.
 */
function makePolylines(n: number, seed: number, gaps: boolean) {
  const rnd = mulberry32(seed)
  const xs: number[] = [0, 0]
  const ys: number[] = [0, 0]
  const starts = new Uint32Array(n)
  const ends = new Uint32Array(n)
  for (let e = 0; e < n; e++) {
    starts[e] = xs.length
    const k = rnd() < 0.2 ? Math.floor(rnd() * 4) : Math.floor(rnd() * 60)
    let x = rnd() * 1000
    let y = rnd() * 1000
    const kind = rnd()
    for (let p = 0; p < k; p++) {
      if (kind < 0.1) {
        x += 1 // straight
      } else if (kind < 0.15) {
        // all coincident
      } else {
        x += (rnd() - 0.3) * 5
        y += (rnd() - 0.5) * (kind < 0.5 ? 0.5 : 5)
      }
      xs.push(rnd() < 0.01 ? NaN : x)
      ys.push(y)
    }
    ends[e] = xs.length
    if (gaps && rnd() < 0.05) {
      xs.push(x) // a point between ranges
      ys.push(y)
    }
    if (gaps && rnd() < 0.02) ends[e] = starts[e] // an empty range
  }
  xs.push(0) // a point after every range
  ys.push(0)
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys), starts, ends }
}

const TOLERANCES = [0, 0.1, 1, 25]

describe('simplifyPaths', () => {
  for (const n of SIZES) {
    it(`matches exactly: ${n} polylines`, () => {
      const { xs, ys, starts, ends } = makePolylines(n, 500 + n, true)
      for (const tolerance of TOLERANCES) {
        // Only the first half of the ranges, to check `count`.
        for (const count of [n, n >> 1]) {
          const want = new Uint8Array(xs.length).fill(7)
          const got = new Uint8Array(xs.length).fill(7)
          tsKernels.simplifyPaths(xs, ys, starts, ends, count, tolerance, want)
          wasm.simplifyPaths(xs, ys, starts, ends, count, tolerance, got)
          expect(got).toEqual(want)
        }
      }
    })
  }
})

describe('createSimplifier', () => {
  for (const gaps of [false, true]) {
    for (const n of SIZES) {
      it(`matches simplifyPaths exactly: ${n} polylines, ${gaps ? 'with gaps' : 'packed'}`, () => {
        const { xs, ys, starts, ends } = makePolylines(n, 700 + n, gaps)
        for (const count of [n, n >> 1]) {
          const a = tsKernels.createSimplifier(xs, ys, starts, ends, count)
          const b = wasm.createSimplifier(xs, ys, starts, ends, count)
          try {
            // One simplifier, many tolerances (and a repeat), into masks of several lengths.
            for (const tolerance of [...TOLERANCES, 0.1]) {
              for (const len of [xs.length, xs.length >> 1, 1, 0, xs.length + 3]) {
                const want = new Uint8Array(len).fill(7)
                const got = new Uint8Array(len).fill(7)
                tsKernels.simplifyPaths(xs, ys, starts, ends, count, tolerance, want)
                b.simplify(tolerance, got)
                expect(got).toEqual(want)
                const viaTs = new Uint8Array(len).fill(7)
                a.simplify(tolerance, viaTs)
                expect(viaTs).toEqual(want)
              }
            }
          } finally {
            a.dispose()
            b.dispose()
          }
        }
      })
    }
  }

  it('handles ranges that reach past the points', () => {
    const xs = Float64Array.of(0, 1, 2, 3, 4, 5)
    const ys = Float64Array.of(0, 3, 0, 3, 0, 3)
    const starts = Uint32Array.of(0, 3)
    const ends = Uint32Array.of(3, 9)
    for (const len of [6, 10, 2]) {
      const want = new Uint8Array(len).fill(7)
      const got = new Uint8Array(len).fill(7)
      tsKernels.simplifyPaths(xs, ys, starts, ends, 2, 0.5, want)
      wasm.createSimplifier(xs, ys, starts, ends, 2).simplify(0.5, got)
      expect(got).toEqual(want)
    }
  })

  it('captures the points when created and refuses use after dispose', () => {
    const { xs, ys, starts, ends } = makePolylines(100, 5, false)
    const s = wasm.createSimplifier(xs, ys, starts, ends, 100)
    const want = new Uint8Array(xs.length)
    tsKernels.simplifyPaths(xs.slice(), ys, starts, ends, 100, 1, want)
    xs.fill(0) // later changes are not seen by the WASM side
    const got = new Uint8Array(xs.length)
    s.simplify(1, got)
    expect(got).toEqual(want)
    s.dispose()
    s.dispose()
    expect(() => s.simplify(1, got)).toThrow()
  })
})
