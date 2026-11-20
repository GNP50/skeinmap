import { describe, expect, it } from 'vitest'
import { SceneBuilder, emptyScene, isRouted, sceneBounds, validateScene } from '../src/scene'

describe('SceneBuilder', () => {
  it('builds flat arrays and returns indices', () => {
    const b = new SceneBuilder({ nodes: 1, edges: 1 })
    const a = b.node(1, 2, 3)
    const c = b.node(4, 5)
    expect([a, c]).toEqual([0, 1])
    expect(b.edge(a, c, 2)).toBe(0)
    const s = b.build()
    expect(s.nodeCount).toBe(2)
    expect(Array.from(s.nodeX)).toEqual([1, 4])
    expect(Array.from(s.nodeY)).toEqual([2, 5])
    expect(Array.from(s.nodeStyle)).toEqual([3, 0])
    expect(Array.from(s.edgeFrom)).toEqual([0])
    expect(Array.from(s.edgeTo)).toEqual([1])
    expect(Array.from(s.edgeStyle)).toEqual([2])
    expect(s.pathX).toBeUndefined()
    expect(validateScene(s)).toEqual([])
  })

  it('grows past its capacity hints', () => {
    const b = new SceneBuilder({ nodes: 2, edges: 2 })
    for (let i = 0; i < 10_000; i++) b.node(i, -i, i % 32)
    for (let i = 1; i < 10_000; i++) b.edge(i - 1, i, i % 7)
    const s = b.build()
    expect(s.nodeCount).toBe(10_000)
    expect(s.edgeCount).toBe(9_999)
    expect(s.nodeX[9_999]).toBe(9_999)
    expect(s.nodeStyle[33]).toBe(1)
    expect(validateScene(s)).toEqual([])
  })

  it('stores paths given as pairs or flat arrays, and ignores short ones', () => {
    const b = new SceneBuilder()
    const a = b.node(0, 0)
    const c = b.node(10, 0)
    b.edge(a, c, 0, [
      [0, 0],
      [5, 3],
      [10, 0],
    ])
    b.edge(a, c, 0, [0, 0, 5, -3, 10, 0])
    b.edge(a, c, 0, [[0, 0]])
    b.edge(a, c, 0)
    const s = b.build()
    expect(Array.from(s.edgePathStart!)).toEqual([0, 3, 6, 6])
    expect(Array.from(s.edgePathEnd!)).toEqual([3, 6, 6, 6])
    expect(Array.from(s.pathY!)).toEqual([0, 3, 0, 0, -3, 0])
    expect([0, 1, 2, 3].map((e) => isRouted(s, e))).toEqual([true, true, false, false])
    expect(validateScene(s)).toEqual([])
  })

  it('can keep building after build()', () => {
    const b = new SceneBuilder()
    b.node(0, 0)
    const first = b.build()
    b.node(1, 1)
    expect(first.nodeCount).toBe(1)
    expect(b.build().nodeCount).toBe(2)
  })
})

describe('scene helpers', () => {
  it('bounds cover nodes and path points', () => {
    expect(sceneBounds(emptyScene())).toBeNull()
    const b = new SceneBuilder()
    const a = b.node(1, 1)
    const c = b.node(3, 2)
    b.edge(a, c, 0, [
      [1, 1],
      [2, 9],
      [3, 2],
    ])
    expect(sceneBounds(b.build())).toEqual([1, 1, 3, 9])
  })

  it('validateScene reports broken invariants', () => {
    const s = emptyScene()
    s.nodeCount = 1
    expect(validateScene(s)[0]).toMatch(/node arrays/)
    const b = new SceneBuilder()
    b.node(0, 0, 40)
    b.edge(0, 5)
    const problems = validateScene(b.build())
    expect(problems.some((p) => p.includes('style 40'))).toBe(true)
    expect(problems.some((p) => p.includes('out of range'))).toBe(true)
  })
})
