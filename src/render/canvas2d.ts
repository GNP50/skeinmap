import { HIDDEN, isRouted, type Scene } from '../scene'
import { FALLBACK_EDGE_STYLE, FALLBACK_NODE_STYLE, type SceneStyles } from '../styles'

/**
 * Canvas 2D backend: draws the scene with plain canvas calls from positions already in
 * absolute pixels (see the layer). Elements are culled against the viewport, sub-pixel
 * work is skipped, and state changes happen once per run of equal styles, so callers
 * that build scenes grouped by style get a handful of state changes per frame. Elements
 * with their own colour or size are drawn one by one.
 *
 * @module
 */

export interface Canvas2dFrame {
  ctx: CanvasRenderingContext2D
  scene: Scene
  styles: SceneStyles
  /** Absolute pixel positions (nodes and path points) at the current view. */
  projX: Float64Array
  projY: Float64Array
  projPX: Float64Array
  projPY: Float64Array
  /** Per-edge box of routed edges, see `GridPositions.edgeBox`. */
  edgeBox: Float64Array | undefined
  /** Path points to draw (1) or skip (0) at this zoom — a simplification mask. */
  pathKeep: Uint8Array | null
  /** Absolute pixel of the container's top-left corner. */
  offX: number
  offY: number
  width: number
  height: number
  dpr: number
  scale: number
  /** Absolute-pixel offsets at which the scene is drawn (world copies). Default `[[0, 0]]`. */
  copies?: readonly (readonly [number, number])[]
  /** Scratch for the node level-of-detail bitmask, reused between frames. */
  scratch: { cells: Uint32Array }
}

/** `0xRRGGBBAA` as a CSS colour. */
export function cssOfPacked(c: number): string {
  return `rgba(${c >>> 24},${(c >>> 16) & 255},${(c >>> 8) & 255},${(c & 255) / 255})`
}

/** Element `i`'s own colour, or 0 when it has none (no array, or alpha 0). */
export function packedOf(colors: Uint32Array | undefined, i: number): number {
  if (!colors) return 0
  const c = colors[i]
  return (c & 0xff) !== 0 ? c : 0
}

/** Radius of node `i` before scaling: its own size when it has one, else its style's. */
export function baseRadius(scene: Scene, styles: SceneStyles, i: number): number {
  const own = scene.nodeRadius ? scene.nodeRadius[i] : 0
  return own > 0 ? own : (styles.nodes[scene.nodeStyle[i]] ?? FALLBACK_NODE_STYLE).radius
}

/** Width of edge `e` before scaling: its own width when it has one, else its style's. */
export function baseWidth(scene: Scene, styles: SceneStyles, e: number): number {
  const own = scene.edgeWidth ? scene.edgeWidth[e] : 0
  return own > 0 ? own : (styles.edges[scene.edgeStyle[e]] ?? FALLBACK_EDGE_STYLE).width
}

const NO_COPIES: readonly (readonly [number, number])[] = [[0, 0]]
const PAD = 64

/** Draw a frame. Returns the number of elements (nodes + edges) that were drawn. */
export function drawCanvas2d(f: Canvas2dFrame): number {
  const { ctx } = f
  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0)
  ctx.clearRect(0, 0, f.width, f.height)
  const copies = f.copies && f.copies.length > 0 ? f.copies : NO_COPIES
  let drawn = 0
  for (const [dx, dy] of copies) drawn += drawEdges(f, f.offX - dx, f.offY - dy)
  for (const [dx, dy] of copies) drawArrows(f, f.offX - dx, f.offY - dy)
  // The node level-of-detail cells are screen cells, shared by every copy.
  resetCells(f)
  for (const [dx, dy] of copies) drawn += drawNodes(f, f.offX - dx, f.offY - dy)
  return drawn
}

function drawEdges(f: Canvas2dFrame, offX: number, offY: number): number {
  const { ctx, scene, styles, projX, projY, projPX, projPY, edgeBox, pathKeep, scale } = f
  const minX = -PAD
  const minY = -PAD
  const maxX = f.width + PAD
  const maxY = f.height + PAD
  const colors = scene.edgeColor
  const widths = scene.edgeWidth
  let drawn = 0
  let lastEdgeStyle = -1
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const starts = scene.edgePathStart
  const ends = scene.edgePathEnd
  ctx.beginPath()
  for (let e = 0; e < scene.edgeCount; e++) {
    const si = scene.edgeStyle[e]
    if (si === HIDDEN) continue
    const routed = edgeBox !== undefined && isRouted(scene, e)
    let ax: number, ay: number, bx: number, by: number
    if (routed) {
      ax = edgeBox[e * 4] - offX
      ay = edgeBox[e * 4 + 1] - offY
      bx = edgeBox[e * 4 + 2] - offX
      by = edgeBox[e * 4 + 3] - offY
    } else {
      ax = projX[scene.edgeFrom[e]] - offX
      ay = projY[scene.edgeFrom[e]] - offY
      bx = projX[scene.edgeTo[e]] - offX
      by = projY[scene.edgeTo[e]] - offY
    }
    // Cheap rejection: both ends beyond the same side of the viewport.
    if ((ax < minX && bx < minX) || (ax > maxX && bx > maxX)) continue
    if ((ay < minY && by < minY) || (ay > maxY && by > maxY)) continue
    // A straight edge shorter than a pixel draws nothing visible.
    if (!routed && Math.abs(ax - bx) + Math.abs(ay - by) < 1) continue

    const ownColor = packedOf(colors, e)
    const ownWidth = widths ? widths[e] : 0
    const own = ownColor !== 0 || ownWidth > 0
    if (own || si !== lastEdgeStyle) {
      ctx.stroke()
      ctx.beginPath()
      const s = styles.edges[si] ?? FALLBACK_EDGE_STYLE
      ctx.strokeStyle = ownColor !== 0 ? cssOfPacked(ownColor) : s.color
      ctx.lineWidth = Math.max(0.5, (ownWidth > 0 ? ownWidth : s.width) * scale)
      ctx.globalAlpha = ownColor !== 0 ? 1 : (s.opacity ?? 1)
      ctx.setLineDash(s.dashed ? [2, 4] : [])
      // An element with its own colour or width ends the run; the next one restarts it.
      lastEdgeStyle = own ? -1 : si
    }
    drawn++
    if (routed) {
      // Points dropped by the simplification mask, or closer than a pixel to the last
      // one drawn, are skipped: a polyline traced at metre resolution is hundreds of
      // sub-pixel segments once zoomed out.
      const s0 = starts![e]
      const s1 = ends![e]
      let lx = projPX[s0] - offX
      let ly = projPY[s0] - offY
      ctx.moveTo(lx, ly)
      for (let p = s0 + 1; p < s1; p++) {
        const last = p === s1 - 1
        if (!last && pathKeep && pathKeep[p] === 0) continue
        const x = projPX[p] - offX
        const y = projPY[p] - offY
        if (!last && Math.abs(x - lx) + Math.abs(y - ly) < 1) continue
        ctx.lineTo(x, y)
        lx = x
        ly = y
      }
    } else {
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
    }
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.globalAlpha = 1
  return drawn
}

/** Arrowheads at the `to` end of edges whose style has `arrow`, tip on the node's rim. */
function drawArrows(f: Canvas2dFrame, offX: number, offY: number): void {
  const { ctx, scene, styles, projX, projY, projPX, projPY, scale } = f
  if (!styles.edges.some((s) => s && (s.arrow ?? 0) > 0)) return
  const colors = scene.edgeColor
  for (let e = 0; e < scene.edgeCount; e++) {
    const si = scene.edgeStyle[e]
    if (si === HIDDEN) continue
    const s = styles.edges[si] ?? FALLBACK_EDGE_STYLE
    const len = (s.arrow ?? 0) * scale
    if (!(len > 0)) continue
    const to = scene.edgeTo[e]
    const tx = projX[to] - offX
    const ty = projY[to] - offY
    if (tx < -PAD || ty < -PAD || tx > f.width + PAD || ty > f.height + PAD) continue
    let fx: number, fy: number
    if (isRouted(scene, e)) {
      const p = scene.edgePathEnd![e] - 2
      fx = projPX[p] - offX
      fy = projPY[p] - offY
    } else {
      fx = projX[scene.edgeFrom[e]] - offX
      fy = projY[scene.edgeFrom[e]] - offY
    }
    const dx = tx - fx
    const dy = ty - fy
    const d = Math.hypot(dx, dy)
    const r = Math.max(1, baseRadius(scene, styles, to) * scale)
    // Too short to carry an arrowhead at this zoom.
    if (d < len * 1.5 + r) continue
    const ux = dx / d
    const uy = dy / d
    const px = tx - ux * r
    const py = ty - uy * r
    const bx = px - ux * len
    const by = py - uy * len
    const w = len * 0.45
    ctx.beginPath()
    ctx.moveTo(px, py)
    ctx.lineTo(bx - uy * w, by + ux * w)
    ctx.lineTo(bx + uy * w, by - ux * w)
    ctx.closePath()
    const own = packedOf(colors, e)
    ctx.fillStyle = own !== 0 ? cssOfPacked(own) : s.color
    ctx.globalAlpha = own !== 0 ? 1 : (s.opacity ?? 1)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

function resetCells(f: Canvas2dFrame): void {
  const cols = Math.ceil(f.width / 2) + 1
  const rows = Math.ceil(f.height / 2) + 1
  if (f.scratch.cells.length < cols * rows) f.scratch.cells = new Uint32Array(cols * rows)
  else f.scratch.cells.fill(0, 0, cols * rows)
}

function drawNodes(f: Canvas2dFrame, offX: number, offY: number): number {
  const { ctx, scene, styles, projX, projY, scale } = f
  const minX = -PAD
  const minY = -PAD
  const maxX = f.width + PAD
  const maxY = f.height + PAD
  // Level of detail: a bitmask of styles already drawn per 2×2 px cell. A second node of
  // the same style in a cell is indistinguishable from the first at that size.
  const cols = Math.ceil(f.width / 2) + 1
  const cells = f.scratch.cells
  const colors = scene.nodeColor
  const radii = scene.nodeRadius
  let drawn = 0
  let lastNodeStyle = -1
  let open = false
  const flush = () => {
    if (!open) return
    const s = styles.nodes[lastNodeStyle] ?? FALLBACK_NODE_STYLE
    ctx.fillStyle = s.fill
    ctx.fill()
    if (s.stroke && (s.strokeWidth ?? 0) > 0) {
      ctx.strokeStyle = s.stroke
      ctx.lineWidth = s.strokeWidth!
      ctx.stroke()
    }
    open = false
  }
  for (let i = 0; i < scene.nodeCount; i++) {
    const si = scene.nodeStyle[i]
    if (si === HIDDEN) continue
    const x = projX[i] - offX
    const y = projY[i] - offY
    if (!(x >= minX && x <= maxX && y >= minY && y <= maxY)) continue
    const ownColor = packedOf(colors, i)
    const ownRadius = radii ? radii[i] : 0
    const own = ownColor !== 0 || ownRadius > 0
    if (!own && x >= 0 && y >= 0 && x < f.width && y < f.height) {
      const c = ((y / 2) | 0) * cols + ((x / 2) | 0)
      const bit = (1 << (si & 31)) >>> 0
      if ((cells[c] & bit) !== 0) continue
      cells[c] = (cells[c] | bit) >>> 0
    }
    const s = styles.nodes[si] ?? FALLBACK_NODE_STYLE
    const r = Math.max(1, (ownRadius > 0 ? ownRadius : s.radius) * scale)
    drawn++
    if (own) {
      // Drawn on its own: its colour or size differs from the style's.
      flush()
      lastNodeStyle = -1
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = ownColor !== 0 ? cssOfPacked(ownColor) : s.fill
      ctx.fill()
      if (s.stroke && (s.strokeWidth ?? 0) > 0) {
        ctx.strokeStyle = s.stroke
        ctx.lineWidth = s.strokeWidth!
        ctx.stroke()
      }
      continue
    }
    if (si !== lastNodeStyle) {
      flush()
      ctx.beginPath()
      lastNodeStyle = si
      open = true
    } else if (!open) {
      ctx.beginPath()
      open = true
    }
    ctx.moveTo(x + r, y)
    ctx.arc(x, y, r, 0, Math.PI * 2)
  }
  flush()
  return drawn
}
