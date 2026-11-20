import { describe, expect, it } from 'vitest'
import { curvedPath, greatCirclePath, parallelCurvature } from '../src/paths'

const DEG = Math.PI / 180

/** Central angle in radians between two lon/lat positions (degrees). */
function angle(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const s1 = Math.sin(((lat2 - lat1) * DEG) / 2)
  const s2 = Math.sin(((lon2 - lon1) * DEG) / 2)
  const h = s1 * s1 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * s2 * s2
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

function vec(lon: number, lat: number): [number, number, number] {
  const c = Math.cos(lat * DEG)
  return [c * Math.cos(lon * DEG), c * Math.sin(lon * DEG), Math.sin(lat * DEG)]
}

describe('curvedPath', () => {
  it('starts and ends exactly at a and b with segments + 1 points', () => {
    const p = curvedPath(0.1, 0.2, 10.3, -4.7, 0.3, 10)
    expect(p).toHaveLength(22)
    expect(p.slice(0, 2)).toEqual([0.1, 0.2])
    expect(p.slice(-2)).toEqual([10.3, -4.7])
  })

  it('offsets the midpoint by half the control offset, to the left in a y-down frame', () => {
    // a → b points right; left on screen (y down) is negative y.
    const p = curvedPath(0, 0, 100, 0, 0.2, 2)
    expect(p).toEqual([0, 0, 50, -10, 100, 0])
    const q = curvedPath(0, 0, 100, 0, -0.2, 2)
    expect(q[3]).toBe(10)
    // a → b points down; left on screen is positive x.
    const r = curvedPath(0, 0, 0, 100, 0.2, 2)
    expect(r[2]).toBeCloseTo(10)
    expect(r[3]).toBeCloseTo(50)
  })

  it('mirrors when the direction is reversed', () => {
    const ab = curvedPath(1, 2, 7, 5, 0.25, 8)
    const ba = curvedPath(7, 5, 1, 2, -0.25, 8)
    for (let i = 0; i <= 8; i++) {
      expect(ab[2 * i]).toBeCloseTo(ba[2 * (8 - i)])
      expect(ab[2 * i + 1]).toBeCloseTo(ba[2 * (8 - i) + 1])
    }
  })

  it('falls back to a straight two-point path', () => {
    expect(curvedPath(3, 3, 3, 3)).toEqual([3, 3, 3, 3])
    expect(curvedPath(0, 0, 5, 5, 0)).toEqual([0, 0, 5, 5])
    expect(curvedPath(0, 0, 5, 5, 0.2, 1)).toEqual([0, 0, 5, 5])
  })
})

describe('parallelCurvature', () => {
  it('is 0 for a single edge', () => {
    expect(parallelCurvature(0, 1)).toBe(0)
    expect(parallelCurvature(0, 0)).toBe(0)
  })

  it('fans out symmetrically and distinctly', () => {
    for (const count of [2, 3, 4, 7]) {
      const values = Array.from({ length: count }, (_, i) => parallelCurvature(i, count, 0.1))
      for (let i = 0; i < count; i++) expect(values[i]).toBeCloseTo(-values[count - 1 - i])
      expect(new Set(values.map((v) => v.toFixed(6))).size).toBe(count)
      for (let i = 1; i < count; i++) expect(values[i] - values[i - 1]).toBeCloseTo(0.1)
    }
    expect(parallelCurvature(1, 3)).toBe(0)
    expect(parallelCurvature(0, 2)).not.toBe(0)
  })
})

describe('greatCirclePath', () => {
  it('has exact endpoints, stays on the great circle and moves away monotonically', () => {
    const [lon1, lat1, lon2, lat2] = [9.19, 45.46, -74.01, 40.71]
    const p = greatCirclePath(lon1, lat1, lon2, lat2, 24)
    expect(p).toHaveLength(50)
    expect(p.slice(0, 2)).toEqual([lon1, lat1])
    expect(p.slice(-2)).toEqual([lon2, lat2])
    const total = angle(lon1, lat1, lon2, lat2)
    const a = vec(lon1, lat1)
    const b = vec(lon2, lat2)
    const normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    let prev = -1
    for (let i = 0; i < p.length; i += 2) {
      const d = angle(lon1, lat1, p[i], p[i + 1])
      expect(d).toBeGreaterThan(prev)
      prev = d
      expect(d + angle(p[i], p[i + 1], lon2, lat2)).toBeCloseTo(total, 9)
      const v = vec(p[i], p[i + 1])
      expect(v[0] * normal[0] + v[1] * normal[1] + v[2] * normal[2]).toBeCloseTo(0, 9)
      expect(Math.abs(p[i + 1])).toBeLessThanOrEqual(90)
    }
    // Segments have equal length (spherical linear interpolation).
    expect(angle(p[0], p[1], p[2], p[3])).toBeCloseTo(total / 24, 9)
  })

  it('bulges towards the pole between two points on the same parallel', () => {
    const p = greatCirclePath(-100, 50, 100, 50, 2)
    expect(p[3]).toBeGreaterThan(50)
  })

  it('keeps longitudes continuous across the antimeridian', () => {
    const p = greatCirclePath(170, -10, -170, 10, 16)
    for (let i = 2; i < p.length; i += 2) expect(Math.abs(p[i] - p[i - 2])).toBeLessThan(180)
    expect(p.slice(0, 2)).toEqual([170, -10])
    expect(p[p.length - 2]).toBe(190)
    expect(p[p.length - 1]).toBe(10)
    expect(p[16]).toBeCloseTo(180)
    expect(p[17]).toBeCloseTo(0)
    const q = greatCirclePath(-175, 0, 175, 0, 4)
    expect(q[q.length - 2]).toBe(-185)
  })

  it('handles identical and antipodal points', () => {
    expect(greatCirclePath(12, 34, 12, 34)).toEqual([12, 34, 12, 34])
    const p = greatCirclePath(10, 0, -170, 0, 8)
    expect(p).toHaveLength(18)
    expect(p.slice(0, 2)).toEqual([10, 0])
    expect(p[17]).toBe(0)
    expect(((p[16] % 360) + 360) % 360).toBe(190)
    expect(p[9]).toBeCloseTo(90) // through the North Pole
    for (let i = 2; i < p.length; i += 2) {
      expect(Number.isFinite(p[i])).toBe(true)
      expect(Math.abs(p[i] - p[i - 2])).toBeLessThanOrEqual(180)
    }
    let prev = -1
    for (let i = 0; i < p.length; i += 2) {
      const d = angle(10, 0, p[i], p[i + 1])
      expect(d).toBeGreaterThan(prev - 1e-12)
      prev = d
    }
  })
})
