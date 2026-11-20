import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createClusterIndex } from '../src/cluster'
import { initWasm, kernels, setKernelPreference, tsKernels } from '../src/kernels/index'
import { mercatorInverse, mercatorUnit } from '../src/projection'
import { SceneBuilder, validateScene, type Scene } from '../src/scene'

afterAll(() => setKernelPreference('auto'))

/** A scene in plain units (identity projection). */
function unitScene(
  nodes: [number, number, number?][],
  edges: [number, number, number?][] = [],
  paths: (number[] | null)[] = [],
): Scene {
  const b = new SceneBuilder()
  for (const [x, y, s] of nodes) b.node(x, y, s ?? 0)
  edges.forEach(([from, to, s], e) => b.edge(from, to, s ?? 0, paths[e] ?? undefined))
  return b.build()
}

const ident = { projection: 'identity' as const }

describe('createClusterIndex (identity)', () => {
  // Bounds start at (0, 0) (the top-left node). At zoom 0 with cellPx 10, cells are 10 units.
  const nodes: [number, number, number?][] = [
    [0, 0],
    [4, 2],
    [25, 5],
    [8, 8],
    [27, 9],
    [50, 50],
  ]

  it('counts members and places each cluster at its centroid', () => {
    const index = createClusterIndex(unitScene(nodes), { ...ident, cellPx: 10 })
    const v = index.level(0)
    expect(Array.from(v.clusterOf)).toEqual([0, 0, 1, 0, 1, 2])
    expect(Array.from(v.counts)).toEqual([3, 2, 1])
    expect(v.scene.nodeCount).toBe(3)
    expect(Array.from(v.scene.nodeX)).toEqual([4, 26, 50])
    expect(Array.from(v.scene.nodeY)).toEqual([10 / 3, 7, 50])
    // Clusters of several nodes get style 1, singletons style 0.
    expect(Array.from(v.scene.nodeStyle)).toEqual([1, 1, 0])
    expect(validateScene(v.scene)).toEqual([])
  })

  it('lists the members of each cluster in node order', () => {
    const v = createClusterIndex(unitScene(nodes), { ...ident, cellPx: 10 }).level(0)
    expect(Array.from(v.members(0))).toEqual([0, 1, 3])
    expect(Array.from(v.members(1))).toEqual([2, 4])
    expect(Array.from(v.members(2))).toEqual([5])
    for (const bad of [3, -1, 0.5, NaN]) expect(v.members(bad).length).toBe(0)
  })

  it('splits clusters as the zoom grows (cells are cellPx / 2^zoom units)', () => {
    const index = createClusterIndex(unitScene(nodes), { ...ident, cellPx: 10 })
    expect(index.level(-2).counts.length).toBe(2) // 40-unit cells
    expect(index.level(1).counts.length).toBe(4) // 5-unit cells: 0 with 1, 2 with 4
    expect(index.level(5).counts.length).toBe(6)
  })

  it('uses 60 px cells by default', () => {
    const v = createClusterIndex(unitScene(nodes), ident).level(0)
    expect(Array.from(v.counts)).toEqual([6])
    expect(createClusterIndex(unitScene(nodes), ident).level(3).counts.length).toBe(5) // 7.5-unit cells
  })

  it('aggregates edges: one per unordered pair of distinct clusters, first appearance first', () => {
    const scene = unitScene(nodes, [
      [0, 1], // inside cluster 0: dropped
      [4, 3, 2], // 1 → 0
      [0, 2, 1], // 0 → 1: the same pair
      [5, 3], // 2 → 0
      [2, 5], // 1 → 2
      [1, 4], // 0 → 1 again
    ])
    const v = createClusterIndex(scene, { ...ident, cellPx: 10 }).level(0)
    expect(v.scene.edgeCount).toBe(3)
    expect(Array.from(v.scene.edgeFrom)).toEqual([1, 2, 1])
    expect(Array.from(v.scene.edgeTo)).toEqual([0, 0, 2])
    expect(Array.from(v.scene.edgeStyle)).toEqual([0, 0, 0])
  })

  it('ignores edge paths', () => {
    const scene = unitScene(nodes, [[0, 2]], [[0, 0, 100, 100, 25, 5]])
    const v = createClusterIndex(scene, { ...ident, cellPx: 10 }).level(0)
    expect(v.scene.edgeCount).toBe(1)
    expect(v.scene.edgePathStart).toBeUndefined()
    expect(v.scene.pathX).toBeUndefined()
  })

  it('leaves hidden nodes, edges touching them and hidden edges out', () => {
    const scene = unitScene(
      [
        [0, 0],
        [4, 2, 255],
        [25, 5],
        [8, 8],
        [27, 9, 255],
        [50, 50],
      ],
      [
        [1, 2], // touches a hidden node
        [3, 4], // touches a hidden node
        [0, 5, 255], // hidden itself
        [2, 3], // 1 → 0
        [5, 0], // 2 → 0
      ],
    )
    const v = createClusterIndex(scene, { ...ident, cellPx: 10 }).level(0)
    expect(Array.from(v.clusterOf)).toEqual([0, 0xffffffff, 1, 0, 0xffffffff, 2])
    expect(Array.from(v.counts)).toEqual([2, 1, 1])
    expect(Array.from(v.scene.nodeX)).toEqual([4, 25, 50])
    expect(Array.from(v.scene.nodeStyle)).toEqual([1, 0, 0])
    expect(Array.from(v.members(0))).toEqual([0, 3])
    expect(Array.from(v.scene.edgeFrom)).toEqual([1, 2])
    expect(Array.from(v.scene.edgeTo)).toEqual([0, 0])
  })

  it('makes a singleton of a NaN-positioned node and leaves out edges to missing nodes', () => {
    const b = new SceneBuilder()
    b.node(0, 0)
    b.node(NaN, 0)
    b.node(1, 1)
    b.node(NaN, NaN)
    const scene = b.build()
    scene.edgeCount = 3
    scene.edgeFrom = Uint32Array.of(0, 1, 0)
    scene.edgeTo = Uint32Array.of(1, 3, 99)
    scene.edgeStyle = new Uint8Array(3)
    const v = createClusterIndex(scene, ident).level(0)
    expect(Array.from(v.clusterOf)).toEqual([0, 1, 0, 2])
    expect(Array.from(v.counts)).toEqual([2, 1, 1])
    expect(v.scene.nodeX[1]).toBeNaN()
    expect(Array.from(v.scene.edgeFrom)).toEqual([0, 1])
    expect(Array.from(v.scene.edgeTo)).toEqual([1, 2])
  })

  it('handles an empty scene and a scene of hidden nodes', () => {
    expect(createClusterIndex(unitScene([]), ident).level(4).scene.nodeCount).toBe(0)
    const v = createClusterIndex(unitScene([[1, 1, 255]]), ident).level(4)
    expect(v.scene.nodeCount).toBe(0)
    expect(Array.from(v.clusterOf)).toEqual([0xffffffff])
  })
})

describe('createClusterIndex (mercator)', () => {
  it('clusters in Mercator units and converts centroids back to longitude/latitude', () => {
    const scene = unitScene([
      [9.19, 45.46], // Milan
      [9.2, 45.48],
      [12.49, 41.9], // Rome
      [-0.12, 51.5], // London
    ])
    const index = createClusterIndex(scene)
    const v = index.level(6)
    expect(Array.from(v.counts)).toEqual([2, 1, 1])
    // The centroid is the mean in units, converted back.
    const ux = new Float64Array(2)
    const uy = new Float64Array(2)
    mercatorUnit(9.19, 45.46, ux, uy, 0)
    mercatorUnit(9.2, 45.48, ux, uy, 1)
    const [lon, lat] = mercatorInverse((ux[0] + ux[1]) / 2, (uy[0] + uy[1]) / 2)
    expect(v.scene.nodeX[0]).toBeCloseTo(lon, 9)
    expect(v.scene.nodeY[0]).toBeCloseTo(lat, 9)
    // A singleton maps back to (about) where it was.
    expect(v.scene.nodeX[1]).toBeCloseTo(12.49, 9)
    expect(v.scene.nodeY[1]).toBeCloseTo(41.9, 9)
    // At zoom 0 a 60 px cell is a quarter of the world (in each direction).
    expect(index.level(0).counts.length).toBeLessThanOrEqual(2)
    // Zoomed far in, every node is alone.
    expect(index.level(16).counts.length).toBe(4)
  })
})

describe('caching and kernels', () => {
  const rnd = (() => {
    let a = 12345
    return () => {
      a = (a * 1103515245 + 12345) % 2147483648
      return a / 2147483648
    }
  })()
  const big = (() => {
    const b = new SceneBuilder()
    for (let i = 0; i < 5000; i++) b.node(-10 + rnd() * 40, 36 + rnd() * 24, rnd() < 0.05 ? 255 : 0)
    for (let e = 0; e < 8000; e++) b.edge(Math.floor(rnd() * 5000), Math.floor(rnd() * 5000), rnd() < 0.05 ? 255 : 0)
    return b.build()
  })()

  it('computes each zoom once and refuses use after dispose', () => {
    const spy = vi.spyOn(tsKernels, 'createClusterer')
    setKernelPreference('ts')
    try {
      const index = createClusterIndex(big)
      const a = index.level(5)
      expect(index.level(5)).toBe(a)
      const b = index.level(7)
      expect(b).not.toBe(a)
      expect(index.level(5)).toBe(a)
      expect(spy).toHaveBeenCalledTimes(1) // one clusterer for every zoom
      index.dispose()
      index.dispose()
      expect(() => index.level(5)).toThrow()
    } finally {
      spy.mockRestore()
      setKernelPreference('auto')
    }
  })

  it('produces the same levels on the WebAssembly kernels, switching mid-way', async () => {
    const bytes = readFileSync(new URL('../src/wasm/pkg/skeinmap_wasm_bg.wasm', import.meta.url))
    await expect(initWasm(bytes)).resolves.toBe(true)
    setKernelPreference('ts')
    const viaTs = createClusterIndex(big)
    setKernelPreference('auto')
    expect(kernels().name).toBe('wasm')
    const viaWasm = createClusterIndex(big)
    for (const zoom of [2, 6, 9]) {
      setKernelPreference('ts')
      const a = viaTs.level(zoom)
      setKernelPreference(zoom === 6 ? 'ts' : 'auto') // the index follows the active kernels
      const b = viaWasm.level(zoom)
      expect(b.clusterOf).toEqual(a.clusterOf)
      expect(b.counts).toEqual(a.counts)
      expect(b.scene).toEqual(a.scene)
      expect(Array.from(b.members(0))).toEqual(Array.from(a.members(0)))
    }
    setKernelPreference('auto')
    const v = viaWasm.level(6)
    expect(v.counts.length).toBeGreaterThan(10)
    expect(v.scene.edgeCount).toBeGreaterThan(10)
    let total = 0
    for (const c of v.counts) total += c
    expect(total).toBe(Array.from(big.nodeStyle).filter((s) => s !== 255).length)
    viaTs.dispose()
    viaWasm.dispose()
  })
})
