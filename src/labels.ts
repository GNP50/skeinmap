/**
 * Label placement: greedy, highest priority first, on an occupancy grid. A label that
 * would overlap one already placed is dropped, so a sparse view names every node and a
 * dense one only what is readable. Pure — the layer measures text and draws; this only
 * decides — so it is testable without a canvas.
 *
 * @module
 */

/** One label to consider. Coordinates are container pixels. */
export interface LabelCandidate {
  /** Opaque id handed back in the result (the layer uses the node index). */
  id: number
  /** Anchor: the label is centred on `x`, its baseline at `baseline`. */
  x: number
  baseline: number
  width: number
  /** Higher wins a collision. */
  priority: number
}

export interface LabelPlacementOptions {
  /** Viewport size in pixels. */
  width: number
  height: number
  /** Occupancy cell size in pixels. Default 8. */
  cell?: number
  /** Text height above the baseline. Default 14. */
  lineHeight?: number
  /** Horizontal padding each side. Default 3. */
  padding?: number
  /** Stop after this many labels. Default 220. */
  maxLabels?: number
  /** Reused between calls to avoid an allocation per frame. */
  scratch?: { cells: Uint8Array }
}

/**
 * Choose which candidates get a label. Candidates are visited in priority order (ties by
 * input order); each claims the occupancy cells its box covers if they are all free.
 * Returns the placed candidates in placement order.
 */
export function placeLabels(candidates: readonly LabelCandidate[], options: LabelPlacementOptions): LabelCandidate[] {
  const cell = options.cell ?? 8
  const lineHeight = options.lineHeight ?? 14
  const pad = options.padding ?? 3
  const maxLabels = options.maxLabels ?? 220
  const cols = Math.ceil(options.width / cell) + 1
  const rows = Math.ceil(options.height / cell) + 1
  let cells = options.scratch?.cells
  if (!cells || cells.length < cols * rows) {
    cells = new Uint8Array(cols * rows)
    if (options.scratch) options.scratch.cells = cells
  } else {
    cells.fill(0, 0, cols * rows)
  }

  const order = candidates.map((_, i) => i)
  order.sort((a, b) => candidates[b].priority - candidates[a].priority || a - b)

  const placed: LabelCandidate[] = []
  for (const k of order) {
    if (placed.length >= maxLabels) break
    const c = candidates[k]
    const cx0 = Math.max(0, Math.floor((c.x - c.width / 2 - pad) / cell))
    const cx1 = Math.min(cols - 1, Math.floor((c.x + c.width / 2 + pad) / cell))
    const cy0 = Math.max(0, Math.floor((c.baseline - lineHeight) / cell))
    const cy1 = Math.min(rows - 1, Math.floor((c.baseline + 2) / cell))
    if (cy1 < 0 || cx1 < cx0 || cy0 > cy1) continue
    let free = true
    for (let cy = cy0; cy <= cy1 && free; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (cells[cy * cols + cx]) {
          free = false
          break
        }
      }
    }
    if (!free) continue
    for (let cy = cy0; cy <= cy1; cy++) cells.fill(1, cy * cols + cx0, cy * cols + cx1 + 1)
    placed.push(c)
  }
  return placed
}
