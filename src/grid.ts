import type { GridData } from './kernels/types'

/**
 * Queries over a hit-test grid ({@link GridData}). The grid covers a *window* of the
 * view — the viewport plus a margin — in absolute pixel coordinates. Absolute
 * coordinates do not change when the view pans, so the grid stays valid through a drag
 * and is only rebuilt when the zoom or the scene changes, or the pointer leaves the
 * window. A query looks at the few cells around the pointer instead of every element.
 */
export class SceneGrid {
  constructor(readonly data: GridData) {}

  /** Whether `(x, y)` ± `r` lies inside the indexed window. */
  covers(x: number, y: number, r: number): boolean {
    const w = this.data.win
    return x - r >= w.x0 && x + r <= w.x1 && y - r >= w.y0 && y + r <= w.y1
  }

  /** Every node whose position lies in the cells touched by the `r` box around `(x, y)`. */
  forNodesNear(x: number, y: number, r: number, visit: (i: number) => void): void {
    const d = this.data
    const c0 = this.col(x - r)
    const c1 = this.col(x + r)
    const r0 = this.row(y - r)
    const r1 = this.row(y + r)
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const c = cy * d.cols + cx
        for (let k = d.nodeStart[c]; k < d.nodeStart[c + 1]; k++) visit(d.nodeItems[k])
      }
    }
  }

  /** Every edge whose box touches the `r` box around `(x, y)` (an edge may repeat). */
  forEdgesNear(x: number, y: number, r: number, visit: (e: number) => void): void {
    const d = this.data
    const c0 = this.col(x - r)
    const c1 = this.col(x + r)
    const r0 = this.row(y - r)
    const r1 = this.row(y + r)
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const c = cy * d.cols + cx
        for (let k = d.edgeStart[c]; k < d.edgeStart[c + 1]; k++) visit(d.edgeItems[k])
      }
    }
    for (let k = 0; k < d.longEdges.length; k++) visit(d.longEdges[k])
  }

  private col(x: number): number {
    const d = this.data
    return Math.min(d.cols - 1, Math.max(0, Math.floor((x - d.win.x0) / d.cell)))
  }

  private row(y: number): number {
    const d = this.data
    return Math.min(d.rows - 1, Math.max(0, Math.floor((y - d.win.y0) / d.cell)))
  }
}

/** Squared distance from `(x, y)` to the segment `a–b`. */
export function segmentDistance2(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax
  const vy = by - ay
  const len2 = vx * vx + vy * vy
  let t = len2 === 0 ? 0 : ((x - ax) * vx + (y - ay) * vy) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = ax + t * vx - x
  const dy = ay + t * vy - y
  return dx * dx + dy * dy
}
