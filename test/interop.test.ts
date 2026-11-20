import { describe, expect, it } from 'vitest'
import {
  type GeoJSONFeatureLike,
  type GraphLike,
  sceneFromGeoJSON,
  sceneFromGraph,
  sceneToGeoJSON,
} from '../src/interop'
import { SceneBuilder, validateScene } from '../src/scene'

const point = (x: number, y: number, properties: Record<string, unknown> = {}): GeoJSONFeatureLike => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [x, y] },
  properties,
})

const line = (coordinates: number[][], properties: Record<string, unknown> = {}): GeoJSONFeatureLike => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties,
})

describe('sceneFromGeoJSON', () => {
  it('matches line endpoints to points, even points listed after the line', () => {
    const { scene, nodeFeature, edgeFeature, skipped } = sceneFromGeoJSON({
      type: 'FeatureCollection',
      features: [
        line([
          [0, 0],
          [1, 2],
          [3, 0],
        ]),
        point(0, 0, { kind: 'hub' }),
        point(3, 0),
      ],
    })
    expect(validateScene(scene)).toEqual([])
    expect(scene.nodeCount).toBe(2)
    expect(Array.from(nodeFeature)).toEqual([1, 2])
    expect(scene.edgeCount).toBe(1)
    expect([scene.edgeFrom[0], scene.edgeTo[0]]).toEqual([0, 1])
    expect(Array.from(edgeFeature)).toEqual([0])
    expect(Array.from(scene.pathX!)).toEqual([0, 1, 3])
    expect(Array.from(scene.pathY!)).toEqual([0, 2, 0])
    expect(skipped).toBe(0)
  })

  it('creates shared endpoint nodes when no point matches', () => {
    const { scene, nodeFeature } = sceneFromGeoJSON(
      [
        line([
          [0, 0],
          [5, 5],
        ]),
        line([
          [5, 5],
          [10, 0],
        ]),
        point(10, 0),
      ],
      { endpointStyle: 4 },
    )
    expect(scene.nodeCount).toBe(3)
    expect(Array.from(nodeFeature)).toEqual([2, -1, -1])
    expect(Array.from(scene.nodeStyle)).toEqual([0, 4, 4])
    // [0,0] → created 1, [5,5] → created 2, shared by both lines; [10,0] → point 0.
    expect(Array.from(scene.edgeFrom)).toEqual([1, 2])
    expect(Array.from(scene.edgeTo)).toEqual([2, 0])
    // Two-point lines draw straight: no path stored.
    expect(scene.pathX).toBeUndefined()
  })

  it('snaps endpoints within the tolerance to the nearest node and moves path ends onto it', () => {
    const features = [
      point(0, 0),
      point(0.0004, 0),
      point(10, 10),
      line([
        [0.0003, 0.0001],
        [5, 6],
        [10.0002, 9.9999],
      ]),
    ]
    const exact = sceneFromGeoJSON(features)
    expect(exact.scene.nodeCount).toBe(5)
    const snapped = sceneFromGeoJSON(features, { snap: 0.001 })
    const s = snapped.scene
    expect(s.nodeCount).toBe(3)
    expect([s.edgeFrom[0], s.edgeTo[0]]).toEqual([1, 2])
    expect(Array.from(s.pathX!)).toEqual([0.0004, 5, 10])
    expect(Array.from(s.pathY!)).toEqual([0, 6, 10])
    // Outside the tolerance: a new node.
    const far = sceneFromGeoJSON(features, { snap: 0.0001 })
    expect(far.scene.nodeCount).toBe(5)
    expect(Array.from(far.nodeFeature)).toEqual([0, 1, 2, -1, -1])
  })

  it('snaps across hash grid cell borders', () => {
    const { scene } = sceneFromGeoJSON(
      [
        point(0.999, 0.999),
        line([
          [1.001, 1.001],
          [3, 3],
        ]),
      ],
      { snap: 0.01 },
    )
    expect(scene.nodeCount).toBe(2)
    expect(scene.edgeFrom[0]).toBe(0)
  })

  it('reads multi geometries, calls style callbacks once per feature and counts skipped features', () => {
    const calls: number[] = []
    const result = sceneFromGeoJSON(
      [
        {
          type: 'Feature',
          geometry: {
            type: 'MultiPoint',
            coordinates: [
              [0, 0],
              [1, 1],
              [Number.NaN, 0],
            ],
          },
        },
        {
          type: 'Feature',
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [0, 0],
                [1, 1],
              ],
              [
                [1, 1],
                [2, 0],
                [3, 1],
              ],
              [[9, 9]],
            ],
          },
          properties: { w: 7 },
        },
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [0, 1],
                [0, 0],
              ],
            ],
          },
        },
        { type: 'Feature', geometry: null },
        { type: 'Feature', geometry: { type: 'GeometryCollection' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [Number.POSITIVE_INFINITY, 1] } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[1, 1]] } },
      ],
      {
        nodeStyle: (_f, i) => {
          calls.push(i)
          return 3
        },
        edgeStyle: (f) => Number(f.properties?.w),
      },
    )
    const s = result.scene
    expect(validateScene(s)).toEqual([])
    expect(s.nodeCount).toBe(3)
    expect(Array.from(s.nodeStyle)).toEqual([3, 3, 0])
    expect(Array.from(result.nodeFeature)).toEqual([0, 0, -1])
    expect(calls).toEqual([0])
    expect(s.edgeCount).toBe(2)
    expect(Array.from(result.edgeFeature)).toEqual([1, 1])
    expect(Array.from(s.edgeStyle)).toEqual([7, 7])
    expect(Array.from(s.edgeFrom)).toEqual([0, 1])
    expect(Array.from(s.edgeTo)).toEqual([1, 2])
    expect(Array.from(s.pathX!)).toEqual([1, 2, 3])
    expect(result.skipped).toBe(5)
  })

  it('handles an empty input', () => {
    const { scene, nodeFeature, edgeFeature, skipped } = sceneFromGeoJSON({ features: [] })
    expect(scene.nodeCount).toBe(0)
    expect(scene.edgeCount).toBe(0)
    expect(nodeFeature).toHaveLength(0)
    expect(edgeFeature).toHaveLength(0)
    expect(skipped).toBe(0)
  })
})

/** A minimal graphology look-alike, implementing only what sceneFromGraph needs. */
class FakeGraph implements GraphLike<Record<string, unknown>, Record<string, unknown>> {
  nodes = new Map<string, Record<string, unknown>>()
  edges = new Map<string, { attributes: Record<string, unknown>; source: string; target: string }>()
  get order() {
    return this.nodes.size
  }
  get size() {
    return this.edges.size
  }
  addNode(key: string, attributes: Record<string, unknown>) {
    this.nodes.set(key, attributes)
  }
  addEdge(key: string, source: string, target: string, attributes: Record<string, unknown> = {}) {
    this.edges.set(key, { attributes, source, target })
  }
  forEachNode(callback: (key: string, attributes: Record<string, unknown>) => void) {
    for (const [key, attributes] of this.nodes) callback(key, attributes)
  }
  forEachEdge(callback: (key: string, attributes: Record<string, unknown>, source: string, target: string) => void) {
    for (const [key, { attributes, source, target }] of this.edges) callback(key, attributes, source, target)
  }
}

describe('sceneFromGraph', () => {
  it('reads positions and styles, skipping nodes without finite coordinates and their edges', () => {
    const g = new FakeGraph()
    g.addNode('a', { x: 1, y: 2, kind: 1 })
    g.addNode('b', { x: 3, y: 4 })
    g.addNode('nowhere', { x: 5 })
    g.addNode('nan', { x: Number.NaN, y: 0 })
    g.addNode('text', { x: '1', y: '2' })
    g.addNode('c', { x: -1, y: -2, kind: 2 })
    g.addEdge('ab', 'a', 'b', { w: 5 })
    g.addEdge('a-nowhere', 'a', 'nowhere')
    g.addEdge('cb', 'c', 'b')
    g.addEdge('nan-c', 'nan', 'c')
    const { scene, nodeKeys, edgeKeys, nodeIndex } = sceneFromGraph(g, {
      nodeStyle: (_k, attributes) => Number(attributes.kind ?? 0),
      edgeStyle: (_k, attributes, source) => (source === 'a' ? Number(attributes.w) : 1),
    })
    expect(validateScene(scene)).toEqual([])
    expect(nodeKeys).toEqual(['a', 'b', 'c'])
    expect(Array.from(scene.nodeX)).toEqual([1, 3, -1])
    expect(Array.from(scene.nodeY)).toEqual([2, 4, -2])
    expect(Array.from(scene.nodeStyle)).toEqual([1, 0, 2])
    expect(edgeKeys).toEqual(['ab', 'cb'])
    expect(Array.from(scene.edgeFrom)).toEqual([0, 2])
    expect(Array.from(scene.edgeTo)).toEqual([1, 1])
    expect(Array.from(scene.edgeStyle)).toEqual([5, 1])
    expect(nodeIndex.get('c')).toBe(2)
    expect(nodeIndex.has('nowhere')).toBe(false)
  })

  it('reads custom coordinate attributes and works without order/size', () => {
    const graph: GraphLike<{ lon?: number; lat?: number }> = {
      forEachNode(cb) {
        cb('mil', { lon: 9.19, lat: 45.46 })
        cb('rom', { lon: 12.49, lat: 41.9 })
      },
      forEachEdge(cb) {
        cb('e0', {}, 'mil', 'rom')
      },
    }
    const { scene, edgeKeys } = sceneFromGraph(graph, { x: 'lon', y: 'lat' })
    expect(Array.from(scene.nodeX)).toEqual([9.19, 12.49])
    expect(Array.from(scene.nodeY)).toEqual([45.46, 41.9])
    expect(edgeKeys).toEqual(['e0'])
  })
})

describe('sceneToGeoJSON', () => {
  it('exports points and lines with their properties', () => {
    const b = new SceneBuilder()
    const a = b.node(0, 0, 2)
    const c = b.node(4, 0, 3)
    b.edge(a, c, 1)
    b.edge(c, a, 5, [4, 0, 2, 2, 0, 0])
    const fc = sceneToGeoJSON(b.build())
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features).toHaveLength(4)
    expect(fc.features[1]).toEqual({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [4, 0] },
      properties: { index: 1, style: 3 },
    })
    expect(fc.features[2]).toEqual({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [4, 0],
        ],
      },
      properties: { index: 0, from: 0, to: 1, style: 1 },
    })
    expect(fc.features[3].geometry.coordinates).toEqual([
      [4, 0],
      [2, 2],
      [0, 0],
    ])
    expect(fc.features[3].properties).toEqual({ index: 1, from: 1, to: 0, style: 5 })
  })

  it('round-trips through sceneFromGeoJSON', () => {
    const b = new SceneBuilder()
    const n = [b.node(9.19, 45.46, 1), b.node(12.49, 41.9, 2), b.node(7.68, 45.07, 0), b.node(14.27, 40.85, 3)]
    b.edge(n[0], n[1], 4)
    b.edge(n[1], n[3], 2, [12.49, 41.9, 13.5, 41.2, 14.27, 40.85])
    b.edge(n[2], n[0], 0)
    const original = b.build()
    const json = JSON.parse(JSON.stringify(sceneToGeoJSON(original)))
    const { scene, nodeFeature, edgeFeature, skipped } = sceneFromGeoJSON(json, {
      nodeStyle: (f) => Number(f.properties?.style),
      edgeStyle: (f) => Number(f.properties?.style),
    })
    expect(skipped).toBe(0)
    expect(Array.from(nodeFeature)).toEqual([0, 1, 2, 3])
    expect(Array.from(edgeFeature)).toEqual([4, 5, 6])
    for (const key of ['nodeX', 'nodeY', 'nodeStyle', 'edgeFrom', 'edgeTo', 'edgeStyle'] as const) {
      expect(Array.from(scene[key])).toEqual(Array.from(original[key]))
    }
    expect(Array.from(scene.pathX!)).toEqual(Array.from(original.pathX!))
    expect(Array.from(scene.pathY!)).toEqual(Array.from(original.pathY!))
    expect(sceneToGeoJSON(scene)).toEqual(sceneToGeoJSON(original))
  })
})
