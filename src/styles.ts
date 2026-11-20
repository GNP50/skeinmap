/**
 * Style tables. Every node and edge carries one byte that indexes into a small table,
 * so restyling a selection is a byte write plus a repaint — never a rebuild of the
 * geometry.
 *
 * @module
 */

/** How a node is drawn: a disc with an optional centred stroke. */
export interface NodeStyle {
  /** Radius in CSS pixels (multiplied by the layer's `scale`). */
  radius: number
  /** Any CSS colour the browser understands. */
  fill: string
  stroke?: string
  strokeWidth?: number
}

/** How an edge is drawn: a round-capped line. */
export interface EdgeStyle {
  /** Any CSS colour the browser understands. */
  color: string
  /** Width in CSS pixels (multiplied by the layer's `scale`). */
  width: number
  /** 0–1, multiplied into the colour's own alpha. Default 1. */
  opacity?: number
  /** Dashed pattern (2 px on, 4 px off). */
  dashed?: boolean
  /** Arrowhead length in CSS pixels at the `to` end (tip on the node's rim). Default none. */
  arrow?: number
}

/** The table a scene's style bytes index into. At most {@link MAX_STYLES} of each. */
export interface SceneStyles {
  nodes: NodeStyle[]
  edges: EdgeStyle[]
}

/** Style bytes are 0–31: the WebGL backend keeps the table in uniform arrays of 32. */
export const MAX_STYLES = 32

/** Used for a style byte with no entry in the table. */
export const FALLBACK_NODE_STYLE: NodeStyle = { radius: 3, fill: '#888' }
/** Used for a style byte with no entry in the table. */
export const FALLBACK_EDGE_STYLE: EdgeStyle = { color: '#888', width: 1 }

/** Any CSS colour as `0xRRGGBBAA`, for the per-element colour arrays of a scene. */
export function packColor(color: string): number {
  const [r, g, b, a] = parseCssColor(color)
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)))
  return ((c(r) << 24) | (c(g) << 16) | (c(b) << 8) | c(a)) >>> 0
}

/** Straight (not premultiplied) RGBA, each channel in 0–1. */
export type Rgba = [number, number, number, number]

const colorCache = new Map<string, Rgba>()
let colorCtx: CanvasRenderingContext2D | null | undefined

function parseHex(hex: string): Rgba | null {
  const h = hex.slice(1)
  const expand = (s: string) =>
    s
      .split('')
      .map((c) => c + c)
      .join('')
  const full = h.length === 3 || h.length === 4 ? expand(h) : h
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return null
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255
  return [n(0), n(2), n(4), full.length === 8 ? n(6) : 1]
}

function parseRgbFunction(v: string): Rgba | null {
  const m = v.match(/^rgba?\(([^)]+)\)$/i)
  if (!m) return null
  const parts = m[1].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return null
  const ch = (s: string) => (s.endsWith('%') ? (parseFloat(s) / 100) * 255 : parseFloat(s))
  const alpha = parts.length > 3 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1
  const out: Rgba = [ch(parts[0]) / 255, ch(parts[1]) / 255, ch(parts[2]) / 255, alpha]
  return out.every((x) => Number.isFinite(x)) ? out : null
}

/**
 * Any CSS colour as straight RGBA in 0–1. `#rgb[a]`, `#rrggbb[aa]` and `rgb()/rgba()` are
 * parsed directly; anything else (`hsl()`, names, `color(...)`) goes through the
 * browser's own parser on a 2D canvas. Unparseable input is mid grey. Results are cached.
 */
export function parseCssColor(color: string): Rgba {
  const hit = colorCache.get(color)
  if (hit) return hit
  const trimmed = color.trim()
  let out = trimmed.startsWith('#') ? parseHex(trimmed) : parseRgbFunction(trimmed)
  if (!out) {
    if (colorCtx === undefined) {
      colorCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
    }
    if (colorCtx) {
      colorCtx.fillStyle = '#000'
      colorCtx.fillStyle = trimmed
      const v = String(colorCtx.fillStyle)
      out = v.startsWith('#') ? parseHex(v) : parseRgbFunction(v)
    }
  }
  const result = out ?? [0.5, 0.5, 0.5, 1]
  if (colorCache.size > 4096) colorCache.clear()
  colorCache.set(color, result)
  return result
}
