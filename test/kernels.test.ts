import { describe, expect, it } from 'vitest'
import {
  buildGridTs,
  computeClusterLevelTs,
  computeLodLevelTs,
  projectMercatorTs,
  simplifyPathsTs,
  tsKernels,
} from '../src/kernels/ts'
import { MAX_EDGE_CELLS, NO_CLUSTER, type GridData, type GridWindow, type LodGeometry } from '../src/kernels/types'

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

function mercator(lon: number, lat: number): [number, number] {
  const ox = new Float64Array(1)
  const oy = new Float64Array(1)
  projectMercatorTs(Float64Array.of(lon), Float64Array.of(lat), ox, oy, 1)
  return [ox[0], oy[0]]
}

interface Edge {
  from: number
  to: number
  style?: number
}

function geometry(
  xs: number[],
  ys: number[],
  styles: number[] | null,
  edges: Edge[] = [],
  extra: Partial<LodGeometry> = {},
): LodGeometry {
  return {
    nodeCount: xs.length,
    unitX: Float64Array.from(xs),
    unitY: Float64Array.from(ys),
    nodeStyle: Uint8Array.from(styles ?? xs.map(() => 0)),
    edgeCount: edges.length,
    edgeFrom: Uint32Array.from(edges.map((e) => e.from)),
    edgeTo: Uint32Array.from(edges.map((e) => e.to)),
    edgeStyle: Uint8Array.from(edges.map((e) => e.style ?? 0)),
    ...extra,
  }
}

describe('projectMercatorTs', () => {
  it('maps the origin to the centre of the 256-unit world', () => {
    expect(mercator(0, 0)).toEqual([128, 128])
  })

  it('is linear in longitude', () => {
    expect(mercator(-180, 0)[0]).toBe(0)
    expect(mercator(180, 0)[0]).toBe(256)
    expect(mercator(90, 0)[0]).toBe(192)
  })

  it('matches known latitudes', () => {
    // y = 128 · (1 − ln(tan(π/4 + φ/2)) / π)
    for (const lat of [-60, -30, 10, 45, 80]) {
      const phi = (lat * Math.PI) / 180
      const expected = 128 * (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI)
      expect(mercator(0, lat)[1]).toBeCloseTo(expected, 9)
    }
  })

  it('clamps latitude to the square world', () => {
    expect(mercator(0, 89.9)[1]).toBe(mercator(0, 85.0511287798)[1])
    expect(mercator(0, 90)[1]).toBeCloseTo(0, 6)
    expect(mercator(0, -90)[1]).toBeCloseTo(256, 6)
  })

  it('writes only `count` points and passes NaN through', () => {
    const ox = new Float64Array([7, 7, 7])
    const oy = new Float64Array([7, 7, 7])
    projectMercatorTs(Float64Array.of(0, NaN, 0), Float64Array.of(0, 0, 0), ox, oy, 2)
    expect(Array.from(ox)).toEqual([128, NaN, 7])
    expect(Array.from(oy)).toEqual([128, 128, 7])
  })
})

describe('computeLodLevelTs', () => {
  it('handles an empty geometry', () => {
    const level = computeLodLevelTs(geometry([], [], []), 3)
    expect(level.zoom).toBe(3)
    expect(level.nodes.length + level.segEdge.length + level.segP0.length + level.segP1.length).toBe(0)
  })

  it('keeps one node per cell and style, the first in index order', () => {
    // Zoom 0, cellPx 2: cells are 2 units wide.
    const g = geometry([0.5, 1.5, 1, 10, 1.9], [0.5, 1.9, 1, 10, 0.1], [1, 1, 2, 1, 2])
    expect(Array.from(computeLodLevelTs(g, 0).nodes)).toEqual([0, 2, 3])
    // At zoom 2 the cells are 0.5 units wide: every node has its own.
    expect(Array.from(computeLodLevelTs(g, 2).nodes)).toEqual([0, 1, 2, 3, 4])
    // A larger cellPx merges more.
    expect(Array.from(computeLodLevelTs(g, 0, 32).nodes)).toEqual([0, 2])
  })

  it('does not alias styles 16–31 with lower ones, and uses style & 31', () => {
    const g = geometry([1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [4, 20, 36, 20, 31])
    // 36 & 31 === 4 (dropped); 20 and 31 are their own styles.
    expect(Array.from(computeLodLevelTs(g, 0).nodes)).toEqual([0, 1, 4])
  })

  it('drops straight edges inside one cell and draws each (cell pair, style) once', () => {
    const xs = [1, 1.2, 9, 9.1, 30]
    const edges: Edge[] = [
      { from: 0, to: 1 }, // same cell
      { from: 0, to: 2 }, // A–B
      { from: 1, to: 3 }, // A–B again
      { from: 3, to: 0 }, // B–A: the same pair
      { from: 1, to: 3, style: 1 }, // A–B, another style
      { from: 2, to: 4 }, // B–C
      { from: 0, to: 2, style: 32 }, // style 32 & 31 === 0
      { from: 0, to: 2, style: 17 }, // style 17 is not style 1
    ]
    const level = computeLodLevelTs(geometry(xs, xs, null, edges), 0)
    expect(Array.from(level.segEdge)).toEqual([1, 4, 5, 7])
    expect(Array.from(level.segP0)).toEqual([-1, -1, -1, -1])
    expect(Array.from(level.segP1)).toEqual([-1, -1, -1, -1])
    // Zoomed in, the pairs separate.
    expect(Array.from(computeLodLevelTs(geometry(xs, xs, null, edges), 6).segEdge)).toEqual([0, 1, 2, 3, 4, 5, 7])
  })

  it('keeps one point per cell along a routed edge', () => {
    const extra: Partial<LodGeometry> = {
      // Edge 0: points 0–4 in cells 0, 0, 1, 1, 2. Edge 1: two points in one cell (nothing).
      // Edge 2: a single point — drawn straight. Edge 3: an empty range — straight.
      edgePathStart: Uint32Array.of(0, 5, 7, 8),
      edgePathEnd: Uint32Array.of(5, 7, 8, 8),
      unitPX: Float64Array.of(0.1, 0.5, 2.1, 3, 4.5, 7, 7.5, 9),
      unitPY: new Float64Array(8),
    }
    const edges = [0, 1, 2, 3].map(() => ({ from: 0, to: 1 }))
    const level = computeLodLevelTs(geometry([0, 20], [0, 0], null, edges, extra), 0)
    expect(Array.from(level.segEdge)).toEqual([0, 0, 2])
    expect(Array.from(level.segP0)).toEqual([0, 2, -1])
    expect(Array.from(level.segP1)).toEqual([2, 4, -1])
  })

  it('stops a routed edge at its last cell change', () => {
    const extra: Partial<LodGeometry> = {
      edgePathStart: Uint32Array.of(0),
      edgePathEnd: Uint32Array.of(4),
      unitPX: Float64Array.of(0.1, 2.5, 3, 3.5),
      unitPY: new Float64Array(4),
    }
    const level = computeLodLevelTs(geometry([0, 20], [0, 0], null, [{ from: 0, to: 1 }], extra), 0)
    expect([Array.from(level.segP0), Array.from(level.segP1)]).toEqual([[0], [1]])
  })

  it('counts cells from the bounds origin', () => {
    const xs = [0.9, 2.5, 2.9, 3.1]
    const ys = [1, 1, 1, 1]
    const at = (bounds?: [number, number, number, number]) =>
      Array.from(computeLodLevelTs(geometry(xs, ys, null, [], { bounds }), 0).nodes)
    expect(at()).toEqual([0, 1]) // cells [0, 2), [2, 4)
    expect(at([1, 1, 11, 11])).toEqual([0, 1, 3]) // cells [-1, 1), [1, 3), [3, 5)
    expect(at([0.5, 0, 10, 10])).toEqual([0, 1]) // cells [0.5, 2.5), [2.5, 4.5)
    // Rows are counted from y0 too: these two differ only in row.
    const g = geometry([5, 5], [1.9, 2.1], null, [], { bounds: [0, 0.2, 10, 10] })
    expect(Array.from(computeLodLevelTs(g, 0).nodes)).toEqual([0])
    expect(Array.from(computeLodLevelTs({ ...g, bounds: [0, 0, 10, 10] }, 0).nodes)).toEqual([0, 1])
  })

  it('keeps every NaN-positioned node and draws every edge touching one', () => {
    const g = geometry([NaN, NaN, 1, 1], [1, 1, 1, 1], null, [
      { from: 0, to: 1 },
      { from: 0, to: 1 },
      { from: 2, to: 3 },
      { from: 0, to: 2 },
    ])
    const level = computeLodLevelTs(g, 3)
    expect(Array.from(level.nodes)).toEqual([0, 1, 2])
    expect(Array.from(level.segEdge)).toEqual([0, 1, 3])
  })
})

describe('computeLodLevelTs with hidden elements (style 255)', () => {
  it('never keeps a hidden node, so another node represents its cell', () => {
    // 255 & 31 === 31: without the rule node 0 would take the bit and drop node 1.
    const g = geometry([1, 1, 1, NaN], [1, 1, 1, 1], [255, 31, 31, 255])
    expect(Array.from(computeLodLevelTs(g, 0).nodes)).toEqual([1])
  })

  it('still places edges at hidden nodes (only the edge style hides an edge)', () => {
    const g = geometry(
      [1, 1, 9],
      [1, 1, 1],
      [255, 0, 0],
      [
        { from: 0, to: 2 },
        { from: 1, to: 2 },
      ],
    )
    const level = computeLodLevelTs(g, 0)
    expect(Array.from(level.nodes)).toEqual([1, 2])
    expect(Array.from(level.segEdge)).toEqual([0])
  })

  it('draws no segment for a hidden edge, straight or routed, and lets the next one through', () => {
    const extra: Partial<LodGeometry> = {
      edgePathStart: Uint32Array.of(0, 0, 0, 0, 0),
      edgePathEnd: Uint32Array.of(0, 0, 0, 0, 3),
      unitPX: Float64Array.of(0.1, 2.5, 5),
      unitPY: new Float64Array(3),
    }
    const edges = [
      { from: 0, to: 1, style: 255 },
      { from: 0, to: 1, style: 31 }, // same bit as 255 & 31: kept, as the hidden one took none
      { from: 0, to: 1, style: 255 },
      { from: 0, to: 2, style: 255 }, // a NaN end: would always be drawn
      { from: 0, to: 1, style: 255 }, // routed
    ]
    const level = computeLodLevelTs(geometry([0, 20, NaN], [0, 0, 0], null, edges, extra), 0)
    expect(Array.from(level.segEdge)).toEqual([1])
    expect([Array.from(level.segP0), Array.from(level.segP1)]).toEqual([[-1], [-1]])
  })

  it('treats style 254 as visible', () => {
    const g = geometry([1, 30], [1, 1], [254, 254], [{ from: 0, to: 1, style: 254 }])
    const level = computeLodLevelTs(g, 0)
    expect(Array.from(level.nodes)).toEqual([0, 1])
    expect(Array.from(level.segEdge)).toEqual([0])
  })
})

describe('computeClusterLevelTs', () => {
  const run = (
    xs: number[],
    ys: number[],
    styles: number[] | null,
    zoom: number,
    cellPx?: number,
    bounds?: [number, number, number, number],
  ) =>
    computeClusterLevelTs(
      Float64Array.from(xs),
      Float64Array.from(ys),
      Uint8Array.from(styles ?? xs.map(() => 0)),
      xs.length,
      zoom,
      cellPx,
      bounds,
    )
  const plain = (l: ReturnType<typeof run>) => ({
    clusterOf: Array.from(l.clusterOf),
    x: Array.from(l.x),
    y: Array.from(l.y),
    count: Array.from(l.count),
  })

  it('handles no nodes', () => {
    expect(plain(run([], [], [], 6))).toEqual({ clusterOf: [], x: [], y: [], count: [] })
    expect(run([], [], [], 6).zoom).toBe(6)
  })

  it('groups nodes per cell, ids in order of first appearance, centroids as means', () => {
    // Zoom 0, cellPx 4: cells 4 units wide.
    const l = run([1, 9, 3, 10, 1], [1, 1, 2, 3, 50], null, 0, 4)
    expect(plain(l)).toEqual({ clusterOf: [0, 1, 0, 1, 2], x: [2, 9.5, 1], y: [1.5, 2, 50], count: [2, 2, 1] })
    // Zoom 2: cells of 1 unit, every node alone.
    expect(Array.from(run([1, 9, 3, 10, 1], [1, 1, 2, 3, 50], null, 2, 4).count)).toEqual([1, 1, 1, 1, 1])
  })

  it('uses cells of cellPx / 2^zoom units, 60 px by default', () => {
    // At zoom 2 the default cell is 15 units: 0 and 14 share one, 16 does not.
    expect(Array.from(run([0, 14, 16], [0, 0, 0], null, 2).clusterOf)).toEqual([0, 0, 1])
    expect(Array.from(run([0, 14, 16], [0, 0, 0], null, 3).clusterOf)).toEqual([0, 1, 2])
  })

  it('ignores styles other than 255', () => {
    expect(Array.from(run([1, 1.5, 2], [1, 1, 1], [0, 7, 254], 0).count)).toEqual([3])
  })

  it('leaves hidden nodes out of every cluster', () => {
    const l = run([1, 1, NaN, 2], [1, 1, 1, 1], [255, 0, 255, 3], 0)
    expect(plain(l)).toEqual({ clusterOf: [NO_CLUSTER, 0, NO_CLUSTER, 0], x: [1.5], y: [1], count: [2] })
  })

  it('makes a singleton of every NaN-positioned node', () => {
    const l = run([NaN, 1, NaN, 1], [1, 1, 1, NaN], null, 0)
    expect(Array.from(l.clusterOf)).toEqual([0, 1, 2, 3])
    expect(Array.from(l.count)).toEqual([1, 1, 1, 1])
    expect(l.x[0]).toBeNaN()
    expect(l.y[3]).toBeNaN()
  })

  it('sums in node index order', () => {
    const l = run([0.1, 0.2, 0.3, 1e-17], [0, 0, 0, 0], null, 0)
    expect(l.x[0]).toBe((0 + 0.1 + 0.2 + 0.3 + 1e-17) / 4)
  })

  it('counts cells from the bounds origin, like the level of detail', () => {
    const xs = [0.9, 2.5, 2.9, 3.1]
    const ys = [1, 1, 1, 1]
    expect(Array.from(run(xs, ys, null, 0, 2).clusterOf)).toEqual([0, 1, 1, 1])
    expect(Array.from(run(xs, ys, null, 0, 2, [1, 1, 11, 11]).clusterOf)).toEqual([0, 1, 1, 2])
  })

  it('matches a brute-force grouping on random data', () => {
    const rnd = mulberry32(11)
    const n = 5000
    const xs = Array.from({ length: n }, () => rnd() * 256)
    const ys = Array.from({ length: n }, () => rnd() * 256)
    const styles = xs.map(() => (rnd() < 0.05 ? 255 : Math.floor(rnd() * 255)))
    for (const zoom of [0, 3, 6]) {
      const l = run(xs, ys, styles, zoom)
      const cell = 60 / 2 ** zoom
      const groups = new Map<string, number[]>()
      for (let i = 0; i < n; i++) {
        if (styles[i] === 255) continue
        const key = `${Math.floor(xs[i] / cell)},${Math.floor(ys[i] / cell)}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(i)
      }
      const want = [...groups.values()]
      expect(l.count.length).toBe(want.length)
      want.forEach((members, id) => {
        for (const i of members) expect(l.clusterOf[i]).toBe(id)
        expect(l.count[id]).toBe(members.length)
        let sx = 0
        for (const i of members) sx += xs[i]
        expect(l.x[id]).toBe(sx / members.length)
      })
    }
  })

  it('backs a persistent clusterer with the same output', () => {
    const xs = Float64Array.of(1, 2, 70, 71)
    const ys = Float64Array.of(1, 2, 1, 1)
    const styles = new Uint8Array(4)
    const c = tsKernels.createClusterer(xs, ys, styles, 4)
    expect(c.level(2)).toEqual(tsKernels.clusterLevel(xs, ys, styles, 4, 2))
    expect(c.level(0, 200).count).toEqual(Uint32Array.of(4))
    c.dispose()
  })
})

/** Brute-force grid: for each cell, the items in index order. */
function bruteGrid(
  win: GridWindow,
  cell: number,
  xs: Float64Array,
  ys: Float64Array,
  from: Uint32Array,
  to: Uint32Array,
  boxes?: Float64Array,
) {
  const cols = Math.max(1, Math.ceil((win.x1 - win.x0) / cell))
  const rows = Math.max(1, Math.ceil((win.y1 - win.y0) / cell))
  const col = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x - win.x0) / cell)))
  const row = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - win.y0) / cell)))
  const nodes: number[][] = Array.from({ length: cols * rows }, () => [])
  const edges: number[][] = Array.from({ length: cols * rows }, () => [])
  const long: number[] = []
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]
    const y = ys[i]
    if (x >= win.x0 && x < win.x1 && y >= win.y0 && y < win.y1) nodes[row(y) * cols + col(x)].push(i)
  }
  for (let e = 0; e < from.length; e++) {
    let b: number[]
    if (boxes && !Number.isNaN(boxes[e * 4])) b = Array.from(boxes.subarray(e * 4, e * 4 + 4))
    else {
      const [ax, bx, ay, by] = [xs[from[e]], xs[to[e]], ys[from[e]], ys[to[e]]]
      b = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
    }
    if (b.some(Number.isNaN)) continue
    if (b[2] < win.x0 || b[0] > win.x1 || b[3] < win.y0 || b[1] > win.y1) continue
    const [c0, r0, c1, r1] = [col(b[0]), row(b[1]), col(b[2]), row(b[3])]
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_EDGE_CELLS) {
      long.push(e)
      continue
    }
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) edges[r * cols + c].push(e)
  }
  return { cols, rows, nodes, edges, long }
}

function cellsOf(start: Uint32Array, items: Uint32Array): number[][] {
  const out: number[][] = []
  for (let c = 0; c + 1 < start.length; c++) out.push(Array.from(items.subarray(start[c], start[c + 1])))
  return out
}

function topology(from: Uint32Array, to: Uint32Array, nodeCount: number) {
  return { nodeCount, edgeCount: from.length, edgeFrom: from, edgeTo: to }
}

describe('buildGridTs', () => {
  it('matches a brute-force grid on random data', () => {
    const rnd = mulberry32(7)
    for (const [n, m, cell] of [
      [0, 0, 10],
      [1, 1, 10],
      [500, 800, 16],
      [3000, 5000, 7.3],
    ]) {
      const win = { x0: -103.25, y0: 51.5, x1: 397.75, y1: 433 }
      const xs = Float64Array.from({ length: n }, () => win.x0 - 50 + rnd() * 600)
      const ys = Float64Array.from({ length: n }, () => win.y0 - 50 + rnd() * 480)
      for (let i = 0; i < n; i += 37) xs[i] = NaN
      const from = Uint32Array.from({ length: m }, () => Math.floor(rnd() * n))
      const to = Uint32Array.from(
        { length: m },
        (_, e) => (rnd() < 0.9 ? from[e] + 1 : Math.floor(rnd() * n)) % Math.max(1, n),
      )
      const boxes = new Float64Array(m * 4).fill(NaN)
      for (let e = 0; e < m; e += 5) {
        const x = win.x0 - 100 + rnd() * 700
        const y = win.y0 - 100 + rnd() * 600
        boxes.set([x, y, x + rnd() * 200, y + rnd() * 30], e * 4)
      }
      for (const withBoxes of [false, true]) {
        const pos = { projX: xs, projY: ys, edgeBox: withBoxes ? boxes : undefined }
        const g = buildGridTs(topology(from, to, n), pos, win, cell)
        const want = bruteGrid(win, cell, xs, ys, from, to, withBoxes ? boxes : undefined)
        expect([g.cols, g.rows]).toEqual([want.cols, want.rows])
        expect(g.nodeStart.length).toBe(g.cols * g.rows + 1)
        expect(cellsOf(g.nodeStart, g.nodeItems)).toEqual(want.nodes)
        expect(cellsOf(g.edgeStart, g.edgeItems)).toEqual(want.edges)
        expect(Array.from(g.longEdges)).toEqual(want.long)
        expect(g.win).toEqual(win)
        expect(g.win).not.toBe(win)
      }
    }
  })

  it('lists edges covering more than MAX_EDGE_CELLS cells as long edges, in edge order', () => {
    const xs = Float64Array.of(1, 12, 1, 39)
    const ys = Float64Array.of(1, 12, 1, 29)
    const from = Uint32Array.of(0, 0, 3, 0)
    const to = Uint32Array.of(3, 1, 0, 2)
    const win = { x0: 0, y0: 0, x1: 40, y1: 30 }
    const g = buildGridTs(topology(from, to, 4), { projX: xs, projY: ys }, win, 2)
    // Edges 0 and 2 cover 20 × 15 cells; edge 1 covers 7 × 7 = 49.
    expect(Array.from(g.longEdges)).toEqual([0, 2])
    expect(g.edgeItems.filter((e) => e === 1).length).toBe(49)
    expect(g.edgeItems.filter((e) => e === 3).length).toBe(1)
  })

  it('leaves NaN positions and NaN boxes out', () => {
    const xs = Float64Array.of(NaN, 5, 5)
    const ys = Float64Array.of(5, NaN, 5)
    const from = Uint32Array.of(0, 1, 2, 2)
    const to = Uint32Array.of(2, 2, 2, 2)
    const boxes = Float64Array.of(NaN, 0, 0, 0, NaN, 0, 0, 0, 0, NaN, 1, 1, 1, 1, 2, 2)
    const win = { x0: 0, y0: 0, x1: 10, y1: 10 }
    const g = buildGridTs(topology(from, to, 3), { projX: xs, projY: ys, edgeBox: boxes }, win, 10)
    expect(Array.from(g.nodeItems)).toEqual([2])
    expect(Array.from(g.edgeItems)).toEqual([3])
  })

  it('keeps a node whose offset rounds up to the window width in its own row', () => {
    // (x − x0) rounds to 1080 = 27 · 40, one column past the last.
    const win = { x0: -552, y0: 0, x1: 528, y1: 80 }
    const x = 527.9999999999999
    expect(Math.floor((x - win.x0) / 40)).toBe(27)
    const g = buildGridTs(
      topology(new Uint32Array(0), new Uint32Array(0), 2),
      {
        projX: Float64Array.of(x, x),
        projY: Float64Array.of(0.5, 79),
      },
      win,
      40,
    )
    expect([g.cols, g.rows]).toEqual([27, 2])
    const cells = cellsOf(g.nodeStart, g.nodeItems)
    expect(cells[26]).toEqual([0])
    expect(cells[53]).toEqual([1])
    expect(g.nodeItems.length).toBe(2)
  })

  it('returns an empty grid for a NaN window or a non-positive cell', () => {
    const t = topology(Uint32Array.of(0), Uint32Array.of(0), 1)
    const pos = { projX: Float64Array.of(1), projY: Float64Array.of(1) }
    const win = { x0: 0, y0: 0, x1: 10, y1: 10 }
    for (const [w, cell] of [
      [{ ...win, x0: NaN }, 1],
      [{ ...win, y1: Infinity }, 1],
      [win, 0],
      [win, -1],
      [win, NaN],
      [win, 1e-9],
    ] as [GridWindow, number][]) {
      const g: GridData = buildGridTs(t, pos, w, cell)
      expect([g.cols, g.rows, Array.from(g.nodeStart), g.nodeItems.length, g.edgeItems.length]).toEqual([
        1,
        1,
        [0, 0],
        0,
        0,
      ])
    }
  })
})

describe('simplifyPathsTs', () => {
  const run = (xs: number[], ys: number[], ranges: [number, number][], tol: number, keep: Uint8Array) =>
    simplifyPathsTs(
      Float64Array.from(xs),
      Float64Array.from(ys),
      Uint32Array.from(ranges.map((r) => r[0])),
      Uint32Array.from(ranges.map((r) => r[1])),
      ranges.length,
      tol,
      keep,
    )

  it('collapses a straight line to its endpoints', () => {
    const keep = new Uint8Array(5).fill(9)
    run([0, 1, 2, 3, 4], [0, 0, 0, 0, 0], [[0, 5]], 0.01, keep)
    expect(Array.from(keep)).toEqual([1, 0, 0, 0, 1])
  })

  it('keeps a zig-zag above the tolerance and drops it below', () => {
    const keep = new Uint8Array(5)
    run([0, 1, 2, 3, 4], [0, 1, 0, 1, 0], [[0, 5]], 0.5, keep)
    expect(Array.from(keep)).toEqual([1, 1, 1, 1, 1])
    run([0, 1, 2, 3, 4], [0, 1, 0, 1, 0], [[0, 5]], 1, keep)
    expect(Array.from(keep)).toEqual([1, 0, 0, 0, 1])
  })

  it('keeps the farthest point recursively', () => {
    const keep = new Uint8Array(7)
    // A spike at 3 and a smaller bump at 1; the rest is flat.
    run([0, 1, 2, 3, 4, 5, 6], [0, 0.6, 0, 5, 0, 0.1, 0], [[0, 7]], 0.5, keep)
    expect(Array.from(keep)).toEqual([1, 1, 1, 1, 1, 0, 1])
  })

  it('keeps every point of ranges under three points and skips empty ranges', () => {
    const keep = new Uint8Array(7).fill(7)
    run(
      [0, 5, 9, 0, 1, 2, 3],
      [0, 5, 9, 0, 0, 0, 0],
      [
        [0, 2],
        [3, 3],
        [5, 4],
        [3, 6],
      ],
      0.1,
      keep,
    )
    expect(Array.from(keep)).toEqual([1, 1, 7, 1, 0, 1, 7])
  })

  it('leaves points outside every range untouched and honours count', () => {
    const keep = new Uint8Array(8).fill(5)
    simplifyPathsTs(
      Float64Array.of(9, 0, 1, 2, 3, 9, 0, 1),
      new Float64Array(8),
      Uint32Array.of(1, 5),
      Uint32Array.of(5, 8),
      1,
      0.1,
      keep,
    )
    expect(Array.from(keep)).toEqual([5, 1, 0, 0, 1, 5, 5, 5])
  })
})
