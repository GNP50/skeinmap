import type { AdapterEvents, LayerElements, MapAdapter, Viewport } from '../adapter'
import { IDENTITY, MERCATOR, type Projection } from '../projection'
import type { Bounds } from '../scene'

/**
 * A map-less view: drag to pan, wheel or pinch to zoom, on any positioned element. For
 * graphs without geography (scene x/y are world units, y pointing down) — or with it,
 * using `projection: MERCATOR` and no basemap. No dependencies.
 *
 * @module
 */

export interface PanZoomOptions {
  /** Projection of scene coordinates. Default identity (x/y are world units). */
  projection?: Projection
  /** Initial view centre, in units. Default `[0, 0]`. */
  center?: [number, number]
  /** Initial pixels per unit. Default 1. */
  k?: number
  /** Zoom limits, in pixels per unit. Defaults 1e-6 and 1e6. */
  minK?: number
  maxK?: number
  /** Zoom factor per wheel notch. Default 1.0015 per pixel of wheel delta. */
  wheelSpeed?: number
  /** Disable user interaction (programmatic view only). Default true. */
  interactive?: boolean
  /** Arrow keys pan, `+`/`-` zoom, `0` calls `onReset` (the element is made focusable). Default true. */
  keyboard?: boolean
  /** Pixels per arrow-key press. Default 80. */
  keyboardPanStep?: number
  /** Called for the `0` key — typically fit the scene. */
  onReset?: () => void
  /**
   * Shift-drag draws a selection box; on release this is called with its corners in
   * container pixels (pass them to `layer.queryBox`). Without it, shift-drag pans.
   */
  onBoxSelect?: (box: { x0: number; y0: number; x1: number; y1: number }) => void
  /** Class of the selection box element. Default `skeinmap-selection` (see `skeinmap/style.css`). */
  selectionClassName?: string
}

export interface PanZoomAdapter extends MapAdapter {
  /** Current view centre (units) and scale. */
  readonly view: { centerX: number; centerY: number; k: number }
  /** Set the view; `k` in pixels per unit. Repaints. */
  setView(centerX: number, centerY: number, k?: number): void
  /** Fit units `[x0, y0, x1, y1]` into the element with `padding` pixels around. */
  fitBounds(bounds: Bounds, padding?: number): void
  /** Listen to view changes (after the layer repainted). Returns the unsubscribe. */
  onViewChange(callback: (view: { centerX: number; centerY: number; k: number }) => void): () => void
  /** Stop observing the element. The layer's own `destroy()` detaches the canvases. */
  dispose(): void
}

/** Turn `element` into a pan/zoom view for a layer. The element should have a size;
 *  it gets `position: relative` if it is statically positioned. */
export function createPanZoomAdapter(element: HTMLElement, options: PanZoomOptions = {}): PanZoomAdapter {
  const projection = options.projection ?? IDENTITY
  const minK = options.minK ?? 1e-6
  const maxK = options.maxK ?? 1e6
  const wheelSpeed = options.wheelSpeed ?? 1.0015
  const interactive = options.interactive !== false
  let cx = options.center?.[0] ?? 0
  let cy = options.center?.[1] ?? 0
  let k = options.k ?? 1
  let width = element.clientWidth
  let height = element.clientHeight
  let events: AdapterEvents | null = null
  const viewListeners = new Set<(v: { centerX: number; centerY: number; k: number }) => void>()

  if (typeof getComputedStyle !== 'undefined' && getComputedStyle(element).position === 'static') {
    element.style.position = 'relative'
  }

  const changed = () => {
    events?.view()
    const v = { centerX: cx, centerY: cy, k }
    for (const l of viewListeners) l(v)
  }

  const resize =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          const w = element.clientWidth
          const h = element.clientHeight
          if (w === width && h === height) return
          width = w
          height = h
          changed()
        })
      : null
  resize?.observe(element)

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = element.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  /** Zoom by `factor` keeping container point `(px, py)` fixed. */
  const zoomAt = (factor: number, px: number, py: number) => {
    const next = Math.min(maxK, Math.max(minK, k * factor))
    const ux = cx + (px - width / 2) / k
    const uy = cy + (py - height / 2) / k
    cx = ux - (px - width / 2) / next
    cy = uy - (py - height / 2) / next
    k = next
    changed()
  }

  // Pointer state: one pointer pans, two pinch.
  const pointers = new Map<number, [number, number]>()
  let moved = false
  let downAt: [number, number] = [0, 0]
  let pinch: { dist: number; mid: [number, number] } | null = null

  // Shift-drag box selection.
  let box: { x0: number; y0: number; x1: number; y1: number; el: HTMLDivElement } | null = null
  const drawBox = () => {
    if (!box) return
    const { x0, y0, x1, y1, el } = box
    el.style.transform = `translate(${Math.min(x0, x1)}px, ${Math.min(y0, y1)}px)`
    el.style.width = `${Math.abs(x1 - x0)}px`
    el.style.height = `${Math.abs(y1 - y0)}px`
  }

  const onPointerDown = (e: PointerEvent) => {
    if (!interactive) return
    const p = local(e)
    if (e.shiftKey && options.onBoxSelect && pointers.size === 0) {
      const el = document.createElement('div')
      el.className = options.selectionClassName ?? 'skeinmap-selection'
      Object.assign(el.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', zIndex: '999' })
      element.appendChild(el)
      box = { x0: p[0], y0: p[1], x1: p[0], y1: p[1], el }
      drawBox()
      element.setPointerCapture?.(e.pointerId)
      return
    }
    pointers.set(e.pointerId, p)
    element.setPointerCapture?.(e.pointerId)
    if (pointers.size === 1) {
      moved = false
      downAt = p
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }
    }
  }
  const onPointerMove = (e: PointerEvent) => {
    const p = local(e)
    if (box) {
      box.x1 = p[0]
      box.y1 = p[1]
      drawBox()
      return
    }
    const prev = pointers.get(e.pointerId)
    if (!prev) {
      events?.pointerMove(p[0], p[1])
      return
    }
    pointers.set(e.pointerId, p)
    if (pointers.size === 1) {
      if (Math.abs(p[0] - downAt[0]) + Math.abs(p[1] - downAt[1]) > 3) moved = true
      cx -= (p[0] - prev[0]) / k
      cy -= (p[1] - prev[1]) / k
      changed()
    } else if (pointers.size === 2 && pinch) {
      moved = true
      const [a, b] = [...pointers.values()]
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1])
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      cx -= (mid[0] - pinch.mid[0]) / k
      cy -= (mid[1] - pinch.mid[1]) / k
      if (pinch.dist > 0) zoomAt(dist / pinch.dist, mid[0], mid[1])
      else changed()
      pinch = { dist, mid }
    }
  }
  const onPointerUp = (e: PointerEvent) => {
    if (box) {
      const { x0, y0, x1, y1, el } = box
      el.remove()
      box = null
      options.onBoxSelect?.({ x0, y0, x1, y1 })
      return
    }
    const had = pointers.delete(e.pointerId)
    if (pointers.size < 2) pinch = null
    if (had && pointers.size === 0 && !moved) {
      const p = local(e)
      events?.click(p[0], p[1])
    }
  }
  const onPointerLeave = () => {
    if (pointers.size === 0) events?.pointerLeave()
  }
  const keyboard = options.keyboard !== false
  const onKeyDown = (e: KeyboardEvent) => {
    if (!interactive || e.altKey || e.ctrlKey || e.metaKey) return
    const step = (options.keyboardPanStep ?? 80) / k
    switch (e.key) {
      case 'ArrowLeft':
        cx -= step
        break
      case 'ArrowRight':
        cx += step
        break
      case 'ArrowUp':
        cy -= step
        break
      case 'ArrowDown':
        cy += step
        break
      case '+':
      case '=':
        zoomAt(1.5, width / 2, height / 2)
        e.preventDefault()
        return
      case '-':
      case '_':
        zoomAt(1 / 1.5, width / 2, height / 2)
        e.preventDefault()
        return
      case '0':
        options.onReset?.()
        e.preventDefault()
        return
      default:
        return
    }
    e.preventDefault()
    changed()
  }

  const onWheel = (e: WheelEvent) => {
    if (!interactive) return
    e.preventDefault()
    const p = local(e)
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * height : e.deltaY
    zoomAt(Math.pow(wheelSpeed, -delta), p[0], p[1])
  }

  const adapter: PanZoomAdapter = {
    projection,
    cursorTarget: element,
    get view() {
      return { centerX: cx, centerY: cy, k }
    },
    getViewport(): Viewport {
      return { width, height, k, centerX: cx, centerY: cy, rotation: 0, zoom: Math.log2(k) }
    },
    attach(elements: LayerElements, ev: AdapterEvents) {
      events = ev
      width = element.clientWidth
      height = element.clientHeight
      element.appendChild(elements.base)
      element.appendChild(elements.overlay)
      element.appendChild(elements.tooltip)
      element.style.touchAction = 'none'
      element.addEventListener('pointerdown', onPointerDown)
      element.addEventListener('pointermove', onPointerMove)
      element.addEventListener('pointerup', onPointerUp)
      element.addEventListener('pointercancel', onPointerUp)
      element.addEventListener('pointerleave', onPointerLeave)
      element.addEventListener('wheel', onWheel, { passive: false })
      if (keyboard) {
        if (!element.hasAttribute('tabindex')) element.tabIndex = 0
        element.addEventListener('keydown', onKeyDown)
      }
      return () => {
        element.removeEventListener('pointerdown', onPointerDown)
        element.removeEventListener('pointermove', onPointerMove)
        element.removeEventListener('pointerup', onPointerUp)
        element.removeEventListener('pointercancel', onPointerUp)
        element.removeEventListener('pointerleave', onPointerLeave)
        element.removeEventListener('wheel', onWheel)
        element.removeEventListener('keydown', onKeyDown)
        box?.el.remove()
        box = null
        events = null
      }
    },
    setView(x, y, nextK) {
      cx = x
      cy = y
      if (nextK !== undefined) k = Math.min(maxK, Math.max(minK, nextK))
      changed()
    },
    fitBounds(b, padding = 24) {
      const w = Math.max(1, width - 2 * padding)
      const h = Math.max(1, height - 2 * padding)
      const bw = b[2] - b[0]
      const bh = b[3] - b[1]
      cx = (b[0] + b[2]) / 2
      cy = (b[1] + b[3]) / 2
      if (bw > 0 || bh > 0)
        k = Math.min(maxK, Math.max(minK, Math.min(bw > 0 ? w / bw : Infinity, bh > 0 ? h / bh : Infinity)))
      changed()
    },
    onViewChange(cb) {
      viewListeners.add(cb)
      return () => viewListeners.delete(cb)
    },
    dispose() {
      resize?.disconnect()
      viewListeners.clear()
    },
  }
  return adapter
}

export { IDENTITY, MERCATOR }
