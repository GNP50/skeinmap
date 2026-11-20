import { describe, expect, it } from 'vitest'
import { placeLabels, type LabelCandidate } from '../src/labels'

const c = (id: number, x: number, baseline: number, priority = 1, width = 40): LabelCandidate => ({
  id,
  x,
  baseline,
  width,
  priority,
})

describe('placeLabels', () => {
  it('places every label in a sparse view', () => {
    const placed = placeLabels([c(0, 50, 50), c(1, 300, 50), c(2, 50, 300)], { width: 400, height: 400 })
    expect(placed.map((p) => p.id)).toEqual([0, 1, 2])
  })

  it('drops the lower priority of two overlapping labels', () => {
    const placed = placeLabels([c(0, 100, 100, 1), c(1, 105, 102, 3)], { width: 400, height: 400 })
    expect(placed.map((p) => p.id)).toEqual([1])
  })

  it('keeps input order among equal priorities', () => {
    const placed = placeLabels([c(5, 100, 100), c(6, 104, 100)], { width: 400, height: 400 })
    expect(placed.map((p) => p.id)).toEqual([5])
  })

  it('respects maxLabels', () => {
    const many = Array.from({ length: 50 }, (_, i) => c(i, 20 + (i % 10) * 80, 30 + Math.floor(i / 10) * 60))
    expect(placeLabels(many, { width: 1000, height: 400, maxLabels: 7 })).toHaveLength(7)
  })

  it('skips labels entirely above the view and reuses scratch storage', () => {
    const scratch = { cells: new Uint8Array(0) }
    expect(placeLabels([c(0, 100, -40)], { width: 200, height: 200, scratch })).toHaveLength(0)
    const cells = scratch.cells
    expect(cells.length).toBeGreaterThan(0)
    placeLabels([c(0, 100, 100)], { width: 200, height: 200, scratch })
    expect(scratch.cells).toBe(cells)
  })
})
