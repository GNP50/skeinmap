import type { AdapterEvents, LayerElements, MapAdapter, Viewport } from './adapter'
import { SceneGrid, segmentDistance2 } from './grid'
import { kernels, onKernelsChange } from './kernels/index'
import { lodFits, type GridBuilder, type LodGeometry, type LodLevel, type Simplifier } from './kernels/types'
import { placeLabels, type LabelCandidate } from './labels'
import { createLodProvider, type LodProvider } from './lod/provider'
import { MERCATOR_WORLD } from './projection'
import { baseRadius, baseWidth, drawCanvas2d } from './render/canvas2d'
import { createGlRenderer, type GlRenderer, type InstanceSubset } from './render/webgl'
import { HIDDEN, emptyScene, isRouted, type Scene } from './scene'
import type { SceneStyles } from './styles'

/**
 * The layer: one scene, drawn on one canvas, with picking, hover, tooltips and labels.
 *
 * Positions are kept at two levels. *Units* are computed once per scene (the projection
 * — spherical Mercator, identity or custom — runs here, through the WASM or TypeScript
 * kernels). *Absolute pixels* are units times the view's scale and rotation, computed
 * once per zoom: they do not change when the view pans, so a pan only shifts the offset
 * everything is drawn and hit-tested at. The WebGL backend does the multiply on the GPU
 * and needs absolute pixels only for picking and labels.
 *
 * @module
 */

/** What a pick found. */
export interface PickResult {
  kind: 'node' | 'edge'
  index: number
}

/** Colours of the 2D overlay (labels, hover outline). */
export interface OverlayColors {
  /** Label text. Default `#111`. */
  text?: string
  /** Halo around label text. Default `rgba(255,255,255,0.92)`. */
  halo?: string
  /** Hover outline. Default `#2563eb`. */
  accent?: string
}

/** Level-of-detail settings for the WebGL backend. */
export interface LodOptions {
  /** Below this many instances (nodes + segments) the whole scene is always drawn. Default 50 000. */
  minInstances?: number
  /** No levels past this zoom (in `log2(k)`). Default 15. */
  maxZoom?: number
  /** Compute levels in a worker made by this factory (see `skeinmap/lod-worker`). */
  worker?: () => Worker
}

export interface GraphLayerOptions {
  /** The scene to draw. Replace it later with {@link GraphLayer.setScene}. */
  scene?: Scene
  /** The style table, or a function returning it (re-read by {@link GraphLayer.restyle}). */
  styles: SceneStyles | (() => SceneStyles)
  /** Multiplies every radius and width — a number, or a function of the view (for
   *  example {@link zoomScale}). Default 1. */
  scale?: number | ((view: Viewport) => number)
  /** `auto` (default) uses WebGL2 when available and Canvas 2D otherwise. */
  renderer?: 'auto' | 'webgl' | 'canvas'
  /** Pick radius in pixels around a node's disc and along an edge. Default 8. */
  hitRadius?: number
  /** Click on a node. Edges are only tested when no node is hit. */
  onNodeClick?: (index: number) => void
  onEdgeClick?: (index: number) => void
  /** The element under the pointer changed (null: nothing). */
  onHover?: (hit: PickResult | null) => void
  /** Hover text for a node; null for none. */
  nodeTooltip?: (index: number) => string | null
  edgeTooltip?: (index: number) => string | null
  /** Treat tooltip strings as HTML. You must escape every value (see `escapeHtml`). Default false. */
  tooltipHtml?: boolean
  /** Class of the tooltip element. Default `skeinmap-tooltip` (styled by `skeinmap/style.css`). */
  tooltipClassName?: string
  /** Name drawn above a node when it fits; null for never. */
  nodeLabel?: (index: number) => string | null
  /** Higher wins a label collision; ≥ 2 is bold and stays a candidate in dense views;
   *  ≤ 0 is only named when the view is sparse. Default 1. */
  labelPriority?: (index: number) => number
  /** Draw labels. Default true. */
  labels?: boolean
  /** CSS font for labels (the weight is prepended). Default `11px system-ui, sans-serif`. */
  labelFont?: string
  /** Labels per frame at most. Default 220. */
  maxLabels?: number
  /** Past this many nodes in view, only priority ≥ 2 nodes are label candidates. Default 3000. */
  maxLabelCandidates?: number
  overlayColors?: OverlayColors | (() => OverlayColors)
  /** Outline the element under the pointer and show a pointer cursor over what a click
   *  would pick. Default true. */
  hoverHighlight?: boolean
  /** Level of detail on the WebGL backend. Default on; `false` turns it off. */
  lod?: boolean | LodOptions
  /** Douglas–Peucker simplification of polylines per zoom on the Canvas 2D backend. Default true. */
  simplify?: boolean
  /** Draw the scene again on the world copies left and right of the main one, like web
   *  maps repeat their tiles (Mercator adapters only). Default false. */
  worldCopies?: boolean
}

/**
 * Show only part of a scene without rebuilding it: hidden elements are not drawn,
 * picked, labelled or queried. Costs one byte per element and a style upload.
 */
export interface LayerFilter {
  /** `1` visible, `0` hidden, one per node. Absent: every node visible. */
  nodes?: Uint8Array | null
  /** `1` visible, `0` hidden, one per edge. Absent: every edge visible. */
  edges?: Uint8Array | null
  /** Also hide edges with a hidden end. Default true. */
  hideDanglingEdges?: boolean
}

/** Diagnostics. */
export interface LayerStats {
  backend: 'webgl' | 'canvas'
  /** Kernels active now (projection, picking index, levels of detail, simplification). */
  kernels: 'wasm' | 'ts'
  /** Instances in the full scene (WebGL) or elements in the scene (Canvas 2D). */
  instances: number
  /** Instances or elements drawn by the last frame. */
  drawn: number
  /** Level-of-detail zoom used by the last frame (null: full scene). */
  lodZoom: number | null
  /** Milliseconds spent in the last paint (CPU side). */
  frameMs: number
}

export interface GraphLayer {
  /** The scene being drawn (as passed in: filters do not touch it). */
  readonly scene: Scene
  /** Replace the scene (re-projects; style bytes and coordinates may also have been
   *  rewritten in place in the same object). The repaint is coalesced onto the next frame. */
  setScene(scene: Scene): void
  /** Re-read the style table and the style bytes, without touching geometry: the cheap
   *  path for a selection or a theme switch. Coalesced onto the next frame. */
  restyle(styles?: SceneStyles | (() => SceneStyles)): void
  /** Repaint only (labels toggled, scale changed). Coalesced onto the next frame. */
  redraw(): void
  /** Change options; callbacks take effect at once, without rebuilding anything. */
  setOptions(options: Partial<GraphLayerOptions>): void
  /** What is under container pixel `(x, y)`. */
  pick(x: number, y: number): PickResult | null
  /** Visible nodes whose centre lies in the container-pixel box (corners in any order). */
  queryBox(x0: number, y0: number, x1: number, y1: number): Uint32Array
  /** Visible nodes whose centre lies inside the polygon (container pixels; a lasso). */
  queryPolygon(points: readonly (readonly [number, number])[]): Uint32Array
  /** Show only part of the scene (see {@link LayerFilter}); `null` shows everything. */
  setFilter(filter: LayerFilter | null): void
  readonly backend: 'webgl' | 'canvas'
  readonly stats: LayerStats
  /** Remove the layer and release its resources. */
  destroy(): void
}

const DEFAULT_FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif'
const LABEL_HEIGHT = 14
const EMPTY_SUBSET: InstanceSubset = {
  nodes: new Uint32Array(0),
  segEdge: new Uint32Array(0),
  segP0: new Int32Array(0),
  segP1: new Int32Array(0),
}

const raf: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16) as unknown as number
const caf: (id: number) => void =
  typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : (id) => clearTimeout(id)
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * Draw `options.scene` on whatever `adapter` stands for. See {@link GraphLayerOptions}.
 *
 * ```ts
 * const layer = createGraphLayer(adapter, {
 *   scene,
 *   styles: { nodes: [{ radius: 3, fill: '#0ea5e9' }], edges: [{ color: '#64748b', width: 1 }] },
 *   onNodeClick: (i) => console.log('node', i),
 * })
 * ```
 */
export function createGraphLayer(adapter: MapAdapter, initial: GraphLayerOptions): GraphLayer {
  const opts: GraphLayerOptions = { ...initial }
  const doc = typeof document !== 'undefined' ? document : null
  if (!doc) throw new Error('createGraphLayer needs a DOM')

  const makeCanvas = (role: string): HTMLCanvasElement => {
    const c = doc.createElement('canvas')
    c.className = `skeinmap-canvas skeinmap-${role}`
    c.style.position = 'absolute'
    c.style.left = '0'
    c.style.top = '0'
    c.style.pointerEvents = 'none'
    return c
  }

  const tooltip = doc.createElement('div')
  tooltip.className = opts.tooltipClassName ?? 'skeinmap-tooltip'
  tooltip.style.position = 'absolute'
  tooltip.style.left = '0'
  tooltip.style.top = '0'
  tooltip.style.pointerEvents = 'none'
  tooltip.style.display = 'none'
  tooltip.style.zIndex = '1000'
  const elements: LayerElements = { base: makeCanvas('base'), overlay: makeCanvas('overlay'), tooltip }

  let gl: GlRenderer | null = null
  let ctx: CanvasRenderingContext2D | null = null
  const wantGl = (opts.renderer ?? 'auto') !== 'canvas'
  if (wantGl) gl = createGlRenderer(elements.base)
  if (!gl) {
    // A canvas that was asked for WebGL cannot hand out a 2D context.
    if (wantGl) elements.base = makeCanvas('base')
    ctx = elements.base.getContext('2d')
  }
  const octx = elements.overlay.getContext('2d')

  /** The caller's scene, and the one drawn: a shallow copy whose style bytes are the
   *  caller's, or a filtered copy of them. Stable per `setScene`, so caches keyed on it
   *  survive a filter change. */
  let source: Scene = opts.scene ?? emptyScene()
  let scene: Scene = { ...source }
  let filter: LayerFilter | null = null
  let filteredNodes = new Uint8Array(0)
  let filteredEdges = new Uint8Array(0)
  let lodRebin = false
  /** Bring the drawn scene's style bytes and per-element arrays in line with the source. */
  const syncView = () => {
    scene.nodeColor = source.nodeColor
    scene.nodeRadius = source.nodeRadius
    scene.edgeColor = source.edgeColor
    scene.edgeWidth = source.edgeWidth
    if (!filter) {
      scene.nodeStyle = source.nodeStyle
      scene.edgeStyle = source.edgeStyle
      return
    }
    const n = source.nodeCount
    const m = source.edgeCount
    if (filteredNodes.length < n) filteredNodes = new Uint8Array(n)
    if (filteredEdges.length < m) filteredEdges = new Uint8Array(m)
    const fn = filter.nodes
    const fe = filter.edges
    const dangling = filter.hideDanglingEdges !== false
    for (let i = 0; i < n; i++) filteredNodes[i] = fn && fn[i] === 0 ? HIDDEN : source.nodeStyle[i]
    for (let e = 0; e < m; e++) {
      const hidden =
        (fe && fe[e] === 0) ||
        (dangling && (filteredNodes[source.edgeFrom[e]] === HIDDEN || filteredNodes[source.edgeTo[e]] === HIDDEN))
      filteredEdges[e] = hidden ? HIDDEN : source.edgeStyle[e]
    }
    scene.nodeStyle = filteredNodes
    scene.edgeStyle = filteredEdges
  }
  const resolveStyles = (): SceneStyles => (typeof opts.styles === 'function' ? opts.styles() : opts.styles)
  let styles = resolveStyles()
  let glGeometryStale = true
  let glStylesStale = true
  let destroyed = false

  // ── Positions ──────────────────────────────────────────────────────────────
  let unitX: Float64Array = new Float64Array(0)
  let unitY: Float64Array = new Float64Array(0)
  let unitPX: Float64Array = new Float64Array(0)
  let unitPY: Float64Array = new Float64Array(0)
  let unitPAdopted = false
  let unitScene: Scene | null = null
  let unitBounds: [number, number, number, number] = [0, 0, MERCATOR_WORLD, MERCATOR_WORLD]
  let projX: Float64Array = new Float64Array(0)
  let projY: Float64Array = new Float64Array(0)
  let projPX: Float64Array = new Float64Array(0)
  let projPY: Float64Array = new Float64Array(0)
  let edgeBox: Float64Array | undefined
  let projScene: Scene | null = null
  let projK = Number.NaN
  let projRot = Number.NaN
  let grid: SceneGrid | null = null
  let gridBuilder: GridBuilder | null = null
  let gridBuilderScene: Scene | null = null
  let pathKeep: Uint8Array | null = null
  let pathKeepKey = ''
  /** Douglas–Peucker over this scene's polylines, held per scene (WASM copies the points once). */
  let simplifier: Simplifier | null = null
  let simplifierScene: Scene | null = null
  const dropSimplifier = () => {
    simplifier?.dispose()
    simplifier = null
    simplifierScene = null
  }
  const canvasScratch = { cells: new Uint32Array(0) }
  const labelScratch = { cells: new Uint8Array(0) }
  const labelWidths = new Map<string, number>()

  const projectUnits = () => {
    if (unitScene === scene) return
    const k = kernels()
    const n = scene.nodeCount
    if (unitX.length < n) {
      unitX = new Float64Array(n)
      unitY = new Float64Array(n)
    }
    const proj = adapter.projection
    const pn = scene.pathX?.length ?? 0
    const point = { x: 0, y: 0 }
    const run = (xs: Float64Array, ys: Float64Array, ox: Float64Array, oy: Float64Array, count: number) => {
      if (proj.kind === 'mercator') k.projectMercator(xs, ys, ox, oy, count)
      else if (proj.kind === 'identity') {
        ox.set(xs.subarray(0, count))
        oy.set(ys.subarray(0, count))
      } else {
        for (let i = 0; i < count; i++) {
          proj.project(xs[i], ys[i], point)
          ox[i] = point.x
          oy[i] = point.y
        }
      }
    }
    run(scene.nodeX, scene.nodeY, unitX, unitY, n)
    if (proj.kind === 'mercator' && scene.pathUnitX && scene.pathUnitY && scene.pathUnitX.length >= pn) {
      // Pre-projected by the scene builder: adopted, not copied.
      unitPX = scene.pathUnitX
      unitPY = scene.pathUnitY
      unitPAdopted = true
    } else {
      // Never project into an array adopted from a scene: it belongs to that scene.
      if (unitPX.length < pn || unitPAdopted) {
        unitPX = new Float64Array(pn)
        unitPY = new Float64Array(pn)
        unitPAdopted = false
      }
      if (pn > 0) run(scene.pathX!, scene.pathY!, unitPX, unitPY, pn)
    }
    if (proj.kind === 'mercator') unitBounds = [0, 0, MERCATOR_WORLD, MERCATOR_WORLD]
    else {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity
      const grow = (xs: Float64Array, ys: Float64Array, c: number) => {
        for (let i = 0; i < c; i++) {
          if (xs[i] < x0) x0 = xs[i]
          if (xs[i] > x1) x1 = xs[i]
          if (ys[i] < y0) y0 = ys[i]
          if (ys[i] > y1) y1 = ys[i]
        }
      }
      grow(unitX, unitY, n)
      grow(unitPX, unitPY, pn)
      unitBounds = x0 === Infinity ? [0, 0, 1, 1] : [x0, y0, Math.max(x1, x0 + 1e-9), Math.max(y1, y0 + 1e-9)]
    }
    unitScene = scene
  }

  /** Absolute pixels at the view's scale and rotation (CPU side: 2D, picking, labels). */
  const projectAbs = (view: Viewport) => {
    const rot = view.rotation ?? 0
    if (projScene === scene && projK === view.k && projRot === rot) return
    projectUnits()
    const k = view.k
    const cos = Math.cos(rot) * k
    const sin = Math.sin(rot) * k
    const n = scene.nodeCount
    if (projX.length < n) {
      projX = new Float64Array(n)
      projY = new Float64Array(n)
    }
    for (let i = 0; i < n; i++) {
      const ux = unitX[i]
      const uy = unitY[i]
      projX[i] = cos * ux - sin * uy
      projY[i] = sin * ux + cos * uy
    }
    const pn = scene.pathX?.length ?? 0
    if (projPX.length < pn) {
      projPX = new Float64Array(pn)
      projPY = new Float64Array(pn)
    }
    for (let i = 0; i < pn; i++) {
      const ux = unitPX[i]
      const uy = unitPY[i]
      projPX[i] = cos * ux - sin * uy
      projPY[i] = sin * ux + cos * uy
    }
    // Routed edges: their polyline's box — a path can bow far outside the chord.
    if (pn > 0) {
      if (!edgeBox || edgeBox.length < scene.edgeCount * 4) edgeBox = new Float64Array(scene.edgeCount * 4)
      for (let e = 0; e < scene.edgeCount; e++) {
        if (!isRouted(scene, e)) {
          edgeBox[e * 4] = Number.NaN
          continue
        }
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity
        for (let p = scene.edgePathStart![e]; p < scene.edgePathEnd![e]; p++) {
          const x = projPX[p]
          const y = projPY[p]
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
        edgeBox[e * 4] = x0
        edgeBox[e * 4 + 1] = y0
        edgeBox[e * 4 + 2] = x1
        edgeBox[e * 4 + 3] = y1
      }
    } else {
      edgeBox = undefined
    }
    projScene = scene
    projK = view.k
    projRot = rot
    grid = null
  }

  /** Absolute pixel of the container's top-left corner. */
  const offsetOf = (view: Viewport): [number, number] => {
    const rot = view.rotation ?? 0
    const cos = Math.cos(rot) * view.k
    const sin = Math.sin(rot) * view.k
    return [
      cos * view.centerX - sin * view.centerY - view.width / 2,
      sin * view.centerX + cos * view.centerY - view.height / 2,
    ]
  }

  const scaleOf = (view: Viewport): number => {
    const s = opts.scale
    return typeof s === 'function' ? s(view) : (s ?? 1)
  }

  /** `floor(log2(k))`: the zoom whose levels of detail and simplification apply. */
  const levelZoomOf = (view: Viewport) => Math.floor(Math.log2(view.k) + 1e-9)

  /** Unit x offsets of the world copies in view (Mercator only, `worldCopies` on). */
  const copiesOf = (view: Viewport): number[] => {
    if (!opts.worldCopies || adapter.projection.kind !== 'mercator') return [0]
    const reach = Math.hypot(view.width, view.height) / 2 / view.k
    const first = Math.floor((view.centerX - reach) / MERCATOR_WORLD)
    const last = Math.floor((view.centerX + reach) / MERCATOR_WORLD)
    const out: number[] = []
    // At most 9 copies: past that the whole world is a few pixels wide anyway.
    const mid = Math.floor(view.centerX / MERCATOR_WORLD)
    for (let n = Math.max(first, mid - 4); n <= Math.min(last, mid + 4); n++) out.push(n * MERCATOR_WORLD)
    return out.length > 0 ? out : [0]
  }

  /** A unit x offset as an absolute-pixel offset at this view. */
  const absShift = (view: Viewport, dx: number): [number, number] => {
    const rot = view.rotation ?? 0
    return [Math.cos(rot) * view.k * dx, Math.sin(rot) * view.k * dx]
  }

  /** The absolute-pixel shift of the world copy under absolute pixel `(x, y)`. */
  const copyShiftAt = (view: Viewport, x: number, y: number): [number, number] => {
    if (!opts.worldCopies || adapter.projection.kind !== 'mercator') return [0, 0]
    const rot = view.rotation ?? 0
    const ux = (Math.cos(rot) * x + Math.sin(rot) * y) / view.k
    return absShift(view, Math.floor(ux / MERCATOR_WORLD) * MERCATOR_WORLD)
  }

  const lodOptions = (): LodOptions | null => {
    if (opts.lod === false) return null
    return opts.lod === true || opts.lod === undefined ? {} : opts.lod
  }

  // ── Level of detail (WebGL) ────────────────────────────────────────────────
  let lod: LodProvider | null = null
  let lodSceneId = 0
  let lodStyles: { node: Uint8Array; edge: Uint8Array } | null = null
  const lodPending = new Set<number>()
  let lastLevel: number | null = null

  const startLod = () => {
    if (!gl) return
    const lo = lodOptions()
    if (!lo) return
    if (!lod) lod = createLodProvider(onLodLevel, lo.worker)
    lodSceneId++
    lodPending.clear()
    gl.dropLevels()
    gl.setOverlay(EMPTY_SUBSET)
    lodStyles = {
      node: scene.nodeStyle.slice(0, scene.nodeCount),
      edge: scene.edgeStyle.slice(0, scene.edgeCount),
    }
    const geometry: LodGeometry = {
      nodeCount: scene.nodeCount,
      unitX,
      unitY,
      nodeStyle: lodStyles.node,
      edgeCount: scene.edgeCount,
      edgeFrom: scene.edgeFrom,
      edgeTo: scene.edgeTo,
      edgeStyle: lodStyles.edge,
      edgePathStart: scene.pathX ? scene.edgePathStart : undefined,
      edgePathEnd: scene.pathX ? scene.edgePathEnd : undefined,
      unitPX: scene.pathX ? unitPX : undefined,
      unitPY: scene.pathX ? unitPY : undefined,
      bounds: unitBounds,
    }
    lod.setGeometry(lodSceneId, geometry)
  }

  const stopLod = () => {
    lod?.dispose()
    lod = null
    lodStyles = null
    lodPending.clear()
    gl?.dropLevels()
    gl?.setOverlay(EMPTY_SUBSET)
  }

  function onLodLevel(sceneId: number, level: LodLevel) {
    if (!gl || sceneId !== lodSceneId) return
    lodPending.delete(level.zoom)
    // A level that barely shrinks the scene is not worth a second copy on the GPU.
    const size = level.nodes.length + level.segEdge.length
    gl.setLevel(level.zoom, size < gl.fullSize * 0.6 ? level : null)
    scheduleRedraw()
  }

  /** Elements restyled since the levels were binned are drawn on top, so a selection
   *  can never be binned away. */
  const refreshOverlay = () => {
    if (!gl || !lodStyles) return
    const nodes: number[] = []
    for (let i = 0; i < scene.nodeCount; i++) if (scene.nodeStyle[i] !== lodStyles.node[i]) nodes.push(i)
    const edges: number[] = []
    for (let e = 0; e < scene.edgeCount; e++) if (scene.edgeStyle[e] !== lodStyles.edge[e]) edges.push(e)
    if (nodes.length + edges.length > (scene.nodeCount + scene.edgeCount) * 0.05) {
      // A wholesale restyle: re-bin rather than drawing most of the scene twice.
      startLod()
      return
    }
    const segEdge: number[] = []
    const segP0: number[] = []
    const segP1: number[] = []
    for (const e of edges) {
      if (isRouted(scene, e)) {
        for (let p = scene.edgePathStart![e]; p < scene.edgePathEnd![e] - 1; p++) {
          segEdge.push(e)
          segP0.push(p)
          segP1.push(p + 1)
        }
      } else {
        segEdge.push(e)
        segP0.push(-1)
        segP1.push(-1)
      }
    }
    gl.setOverlay({
      nodes: Uint32Array.from(nodes),
      segEdge: Uint32Array.from(segEdge),
      segP0: Int32Array.from(segP0),
      segP1: Int32Array.from(segP1),
    })
  }

  // ── Hover, labels ──────────────────────────────────────────────────────────
  let hoverNode = -1
  let hoverEdge = -1

  const colors = (): Required<OverlayColors> => {
    const c = typeof opts.overlayColors === 'function' ? opts.overlayColors() : (opts.overlayColors ?? {})
    return { text: c.text ?? '#111', halo: c.halo ?? 'rgba(255,255,255,0.92)', accent: c.accent ?? '#2563eb' }
  }

  const nodeRadius = (i: number, scale: number) => Math.max(1, baseRadius(scene, styles, i) * scale)
  let hoverShift: [number, number] = [0, 0]

  const drawLabels = (c: CanvasRenderingContext2D, view: Viewport, offX: number, offY: number, scale: number) => {
    const label = opts.nodeLabel
    if (!label || opts.labels === false) return
    const maxLabels = opts.maxLabels ?? 220
    const maxCand = opts.maxLabelCandidates ?? 3000
    const prio = opts.labelPriority
    let cand: number[] = []
    const important: number[] = []
    // Candidates as (node, copy) pairs: a node near a world-copy seam can be in view twice.
    const shifts = copiesOf(view).map((dx) => absShift(view, dx))
    let candShift: number[] = []
    const importantShift: number[] = []
    for (let k = 0; k < shifts.length; k++) {
      const ox = offX - shifts[k][0]
      const oy = offY - shifts[k][1]
      for (let i = 0; i < scene.nodeCount; i++) {
        const x = projX[i] - ox
        const y = projY[i] - oy
        if (!(x >= 0 && y >= 0 && x <= view.width && y <= view.height)) continue
        if (scene.nodeStyle[i] === HIDDEN) continue
        if (cand.length <= maxCand) {
          cand.push(i)
          candShift.push(k)
        }
        if (prio && important.length < maxCand && prio(i) >= 2) {
          important.push(i)
          importantShift.push(k)
        }
      }
    }
    if (cand.length > maxCand) {
      cand = important
      candShift = importantShift
    }
    const font = opts.labelFont ?? DEFAULT_FONT
    const sparse = cand.length <= maxLabels
    const list: LabelCandidate[] = []
    let measuredFont = ''
    for (let ci = 0; ci < cand.length; ci++) {
      const i = cand[ci]
      const [sx, sy] = shifts[candShift[ci]]
      const p = prio ? prio(i) : 1
      if (p <= 0 && !sparse) continue
      const text = label(i)
      if (!text) continue
      const bold = p >= 2
      const key = bold ? `b\u0000${text}` : text
      let w = labelWidths.get(key)
      if (w === undefined) {
        const f = `${bold ? 700 : 500} ${font}`
        if (measuredFont !== f) {
          c.font = f
          measuredFont = f
        }
        if (labelWidths.size > 20_000) labelWidths.clear()
        w = c.measureText(text).width
        labelWidths.set(key, w)
      }
      list.push({
        id: i,
        x: projX[i] - offX + sx,
        baseline: projY[i] - offY + sy - nodeRadius(i, scale) - 5,
        width: w,
        priority: p,
      })
    }
    if (list.length === 0) return
    const placed = placeLabels(list, {
      width: view.width,
      height: view.height,
      lineHeight: LABEL_HEIGHT,
      maxLabels,
      scratch: labelScratch,
    })
    const palette = colors()
    c.textAlign = 'center'
    c.textBaseline = 'alphabetic'
    c.lineJoin = 'round'
    c.lineWidth = 3
    c.strokeStyle = palette.halo
    c.fillStyle = palette.text
    let current = ''
    for (const l of placed) {
      const f = `${l.priority >= 2 ? 700 : 500} ${font}`
      if (f !== current) {
        c.font = f
        current = f
      }
      const text = label(l.id)!
      c.strokeText(text, l.x, l.baseline)
      c.fillText(text, l.x, l.baseline)
    }
  }

  const drawHover = (c: CanvasRenderingContext2D, baseOffX: number, baseOffY: number, scale: number) => {
    if (hoverNode < 0 && hoverEdge < 0) return
    const offX = baseOffX - hoverShift[0]
    const offY = baseOffY - hoverShift[1]
    const palette = colors()
    c.lineCap = 'round'
    c.lineJoin = 'round'
    if (hoverEdge >= 0 && hoverEdge < scene.edgeCount) {
      const e = hoverEdge
      const width = Math.max(0.5, baseWidth(scene, styles, e) * scale)
      c.beginPath()
      if (isRouted(scene, e)) {
        const s0 = scene.edgePathStart![e]
        c.moveTo(projPX[s0] - offX, projPY[s0] - offY)
        for (let p = s0 + 1; p < scene.edgePathEnd![e]; p++) c.lineTo(projPX[p] - offX, projPY[p] - offY)
      } else {
        c.moveTo(projX[scene.edgeFrom[e]] - offX, projY[scene.edgeFrom[e]] - offY)
        c.lineTo(projX[scene.edgeTo[e]] - offX, projY[scene.edgeTo[e]] - offY)
      }
      c.strokeStyle = palette.accent
      c.globalAlpha = 0.25
      c.lineWidth = width + 8
      c.stroke()
      c.globalAlpha = 1
      c.lineWidth = width + 1.5
      c.stroke()
    }
    if (hoverNode >= 0 && hoverNode < scene.nodeCount) {
      const x = projX[hoverNode] - offX
      const y = projY[hoverNode] - offY
      const r = nodeRadius(hoverNode, scale) + 3.5
      c.beginPath()
      c.arc(x, y, r, 0, Math.PI * 2)
      c.strokeStyle = palette.accent
      c.globalAlpha = 0.25
      c.lineWidth = 7
      c.stroke()
      c.globalAlpha = 1
      c.lineWidth = 2
      c.stroke()
    }
  }

  /** Repaint the overlay alone — all a hover change needs. */
  const drawOverlay = (view: Viewport) => {
    if (!octx) return
    const dpr = elements.overlay.width / Math.max(1, view.width)
    octx.setTransform(dpr, 0, 0, dpr, 0, 0)
    octx.clearRect(0, 0, view.width, view.height)
    const wantLabels = !!opts.nodeLabel && opts.labels !== false
    if (!wantLabels && hoverNode < 0 && hoverEdge < 0) return
    projectAbs(view)
    const [offX, offY] = offsetOf(view)
    const scale = scaleOf(view)
    if (opts.hoverHighlight !== false) drawHover(octx, offX, offY, scale)
    drawLabels(octx, view, offX, offY, scale)
  }

  // ── Paint ──────────────────────────────────────────────────────────────────
  let frame = 0
  let frameMs = 0
  let lastDrawn = 0

  const fallBackTo2d = () => {
    stopLod()
    gl?.dispose()
    gl = null
    const next = makeCanvas('base')
    elements.base.replaceWith(next)
    elements.base = next
    ctx = next.getContext('2d')
  }

  const pathKeepFor = (zoom: number): Uint8Array | null => {
    if (opts.simplify === false || !scene.pathX || !scene.edgePathStart || !scene.edgePathEnd) return null
    const key = `${zoom}`
    if (pathKeep && pathKeepKey === key) return pathKeep
    const n = scene.pathX.length
    if (!pathKeep || pathKeep.length < n) pathKeep = new Uint8Array(n)
    pathKeep.fill(1, 0, n)
    if (!simplifier || simplifierScene !== scene) {
      dropSimplifier()
      const k = kernels()
      simplifier = k.createSimplifier(unitPX, unitPY, scene.edgePathStart, scene.edgePathEnd, scene.edgeCount)
      simplifierScene = scene
    }
    simplifier.simplify(0.5 / Math.pow(2, zoom), pathKeep)
    pathKeepKey = key
    return pathKeep
  }

  const paint = () => {
    if (frame) {
      caf(frame)
      frame = 0
    }
    if (destroyed) return
    const t0 = now()
    if (gl?.lost) fallBackTo2d()
    const view = adapter.getViewport()
    const dpr = view.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
    for (const c of [elements.base, elements.overlay]) {
      const w = Math.max(1, Math.round(view.width * dpr))
      const h = Math.max(1, Math.round(view.height * dpr))
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
        c.style.width = `${view.width}px`
        c.style.height = `${view.height}px`
      }
    }
    adapter.beforePaint?.(elements)
    drawOverlay(view)

    if (gl) {
      if (glGeometryStale) {
        projectUnits()
        gl.setGeometry(scene, unitX, unitY, unitPX, unitPY)
        glGeometryStale = false
        glStylesStale = true
        lodStyles = null
        const lo = lodOptions()
        if (lo && gl.fullSize > (lo.minInstances ?? 50_000)) startLod()
        else stopLod()
      }
      if (glStylesStale) {
        gl.setStyles(scene, styles)
        glStylesStale = false
        // A filter change re-bins: a hidden element must not stand in for visible ones.
        if (lodStyles && lodRebin) startLod()
        else if (lodStyles) refreshOverlay()
        lodRebin = false
      }
      let levelZoom: number | null = null
      const lo = lodOptions()
      if (lod && lodStyles && lo) {
        const z = levelZoomOf(view)
        if (gl.hasLevel(z)) levelZoom = z
        else if (!lodPending.has(z) && z <= (lo.maxZoom ?? 15) && lodFits(unitBounds, z)) {
          lodPending.add(z)
          lod.request(lodSceneId, z)
        }
      }
      lastLevel = levelZoom
      gl.draw(
        {
          centerX: view.centerX,
          centerY: view.centerY,
          k: view.k,
          rotation: view.rotation ?? 0,
          width: view.width,
          height: view.height,
          dpr,
          scale: scaleOf(view),
        },
        levelZoom,
        copiesOf(view),
      )
      lastDrawn = gl.lastDrawn
    } else if (ctx) {
      projectAbs(view)
      const [offX, offY] = offsetOf(view)
      lastLevel = null
      lastDrawn = drawCanvas2d({
        ctx,
        scene,
        styles,
        projX,
        projY,
        projPX,
        projPY,
        edgeBox,
        pathKeep: pathKeepFor(levelZoomOf(view)),
        offX,
        offY,
        width: view.width,
        height: view.height,
        dpr,
        scale: scaleOf(view),
        copies: copiesOf(view).map((dx) => absShift(view, dx)),
        scratch: canvasScratch,
      })
    }
    frameMs = now() - t0
  }

  /** Repaint on the next frame instead of now: a scene change and a restyle in the same
   *  tick land in one paint. View changes still repaint synchronously. */
  const scheduleRedraw = () => {
    if (frame || destroyed) return
    frame = raf(() => {
      frame = 0
      paint()
    })
  }

  // ── Picking ────────────────────────────────────────────────────────────────
  const gridFor = (view: Viewport, x: number, y: number, r: number): SceneGrid => {
    projectAbs(view)
    if (grid && grid.covers(x, y, r)) return grid
    if (!gridBuilder || gridBuilderScene !== scene) {
      gridBuilder?.dispose()
      const k = kernels()
      gridBuilder = k.createGridBuilder({
        nodeCount: scene.nodeCount,
        edgeCount: scene.edgeCount,
        edgeFrom: scene.edgeFrom,
        edgeTo: scene.edgeTo,
      })
      gridBuilderScene = scene
    }
    const [offX, offY] = offsetOf(view)
    // The viewport plus half a screen each side: a drag stays inside it for a while. A
    // point outside it (a world copy) gets a window of the same size around itself.
    const mx = view.width / 2
    const my = view.height / 2
    let win = { x0: offX - mx, y0: offY - my, x1: offX + view.width + mx, y1: offY + view.height + my }
    if (x - r < win.x0 || x + r > win.x1 || y - r < win.y0 || y + r > win.y1) {
      win = { x0: x - view.width, y0: y - view.height, x1: x + view.width, y1: y + view.height }
    }
    grid = new SceneGrid(gridBuilder.build({ projX, projY, edgeBox }, win, 32))
    return grid
  }

  /** Absolute-pixel shift of the world copy the last pick looked at. */
  let pickShift: [number, number] = [0, 0]
  let maxOwnRadiusCache: { arr: Float32Array; value: number } | null = null
  const maxOwnRadius = (): number => {
    const arr = scene.nodeRadius!
    if (maxOwnRadiusCache && maxOwnRadiusCache.arr === arr) return maxOwnRadiusCache.value
    let m = 0
    for (let i = 0; i < scene.nodeCount; i++) if (arr[i] > m) m = arr[i]
    maxOwnRadiusCache = { arr, value: m }
    return m
  }

  /** Visible nodes whose (copy-shifted) container position passes `inside`. */
  const queryNodes = (inside: (x: number, y: number) => boolean): Uint32Array => {
    const view = adapter.getViewport()
    projectAbs(view)
    const [offX, offY] = offsetOf(view)
    const hits = new Set<number>()
    for (const dx of copiesOf(view)) {
      const [sx, sy] = absShift(view, dx)
      for (let i = 0; i < scene.nodeCount; i++) {
        if (scene.nodeStyle[i] === HIDDEN) continue
        if (inside(projX[i] - offX + sx, projY[i] - offY + sy)) hits.add(i)
      }
    }
    return Uint32Array.from([...hits].sort((a, b) => a - b))
  }

  const nodeAt = (cx: number, cy: number): number => {
    const view = adapter.getViewport()
    const scale = scaleOf(view)
    const hitRadius = opts.hitRadius ?? 8
    let maxR = hitRadius
    for (const s of styles.nodes) if (s) maxR = Math.max(maxR, s.radius * scale + 3)
    if (scene.nodeRadius) maxR = Math.max(maxR, maxOwnRadius() * scale + 3)
    const [offX, offY] = offsetOf(view)
    const [sx, sy] = copyShiftAt(view, cx + offX, cy + offY)
    pickShift = [sx, sy]
    const x = cx + offX - sx
    const y = cy + offY - sy
    let best = -1
    let bestD2 = Infinity
    gridFor(view, x, y, maxR).forNodesNear(x, y, maxR, (i) => {
      if (scene.nodeStyle[i] === HIDDEN) return
      const dx = projX[i] - x
      const dy = projY[i] - y
      const r = Math.max(hitRadius, baseRadius(scene, styles, i) * scale + 3)
      const d2 = dx * dx + dy * dy
      if (d2 <= r * r && d2 < bestD2) {
        bestD2 = d2
        best = i
      }
    })
    return best
  }

  const edgeAt = (cx: number, cy: number): number => {
    const view = adapter.getViewport()
    const hitRadius = opts.hitRadius ?? 8
    const [offX, offY] = offsetOf(view)
    const [sx, sy] = copyShiftAt(view, cx + offX, cy + offY)
    pickShift = [sx, sy]
    const x = cx + offX - sx
    const y = cy + offY - sy
    let best = -1
    let bestD2 = hitRadius * hitRadius
    gridFor(view, x, y, hitRadius).forEdgesNear(x, y, hitRadius, (e) => {
      if (scene.edgeStyle[e] === HIDDEN) return
      if (isRouted(scene, e)) {
        for (let p = scene.edgePathStart![e]; p < scene.edgePathEnd![e] - 1; p++) {
          const d2 = segmentDistance2(x, y, projPX[p], projPY[p], projPX[p + 1], projPY[p + 1])
          if (d2 < bestD2) {
            bestD2 = d2
            best = e
          }
        }
        return
      }
      const a = scene.edgeFrom[e]
      const b = scene.edgeTo[e]
      const d2 = segmentDistance2(x, y, projX[a], projY[a], projX[b], projY[b])
      if (d2 < bestD2) {
        bestD2 = d2
        best = e
      }
    })
    return best
  }

  const showTooltip = (text: string | null, x: number, y: number) => {
    if (!text) {
      tooltip.style.display = 'none'
      return
    }
    if (opts.tooltipHtml) tooltip.innerHTML = text
    else tooltip.textContent = text
    tooltip.style.display = 'block'
    // Keep the card inside the view: flip to the other side of the pointer near an edge.
    const view = adapter.getViewport()
    const w = tooltip.offsetWidth
    const h = tooltip.offsetHeight
    const tx = x + 14 + w > view.width ? Math.max(0, x - 14 - w) : x + 14
    const ty = y + 14 + h > view.height ? Math.max(0, y - 14 - h) : y + 14
    tooltip.style.transform = `translate(${tx}px, ${ty}px)`
  }

  const setHover = (node: number, edge: number) => {
    if (node === hoverNode && edge === hoverEdge) return
    hoverNode = node
    hoverEdge = edge
    hoverShift = pickShift
    opts.onHover?.(node >= 0 ? { kind: 'node', index: node } : edge >= 0 ? { kind: 'edge', index: edge } : null)
    if (opts.hoverHighlight === false) return
    const pickable = (node >= 0 && !!opts.onNodeClick) || (edge >= 0 && !!opts.onEdgeClick)
    adapter.cursorTarget.style.cursor = pickable ? 'pointer' : ''
    drawOverlay(adapter.getViewport())
  }

  let hoverFrame = 0
  let hoverAt: [number, number] = [0, 0]
  const events: AdapterEvents = {
    view: paint,
    pointerMove(x, y) {
      const wantNode = !!opts.nodeTooltip || !!opts.onNodeClick || !!opts.onHover
      const wantEdge = !!opts.edgeTooltip || !!opts.onEdgeClick || !!opts.onHover
      if (!wantNode && !wantEdge) return
      hoverAt = [x, y]
      if (hoverFrame) return
      hoverFrame = raf(() => {
        hoverFrame = 0
        if (destroyed) return
        const [px, py] = hoverAt
        const ni = wantNode ? nodeAt(px, py) : -1
        const ei = ni < 0 && wantEdge ? edgeAt(px, py) : -1
        setHover(ni, ei)
        const text = ni >= 0 ? opts.nodeTooltip?.(ni) : ei >= 0 ? opts.edgeTooltip?.(ei) : null
        showTooltip(text ?? null, px, py)
      })
    },
    pointerLeave() {
      setHover(-1, -1)
      showTooltip(null, 0, 0)
    },
    click(x, y) {
      if (opts.onNodeClick) {
        const ni = nodeAt(x, y)
        if (ni >= 0) {
          opts.onNodeClick(ni)
          return true
        }
      }
      if (opts.onEdgeClick) {
        const ei = edgeAt(x, y)
        if (ei >= 0) {
          opts.onEdgeClick(ei)
          return true
        }
      }
      return false
    },
  }

  const detach = adapter.attach(elements, events)

  // When the WebAssembly kernels arrive (or a preference changes), rebuild what they make.
  const offKernels = onKernelsChange(() => {
    gridBuilder?.dispose()
    gridBuilder = null
    grid = null
    dropSimplifier()
    pathKeepKey = ''
    if (lod) startLod()
    scheduleRedraw()
  })

  paint()

  return {
    get scene() {
      return source
    },
    get backend() {
      return gl ? 'webgl' : 'canvas'
    },
    get stats(): LayerStats {
      return {
        backend: gl ? 'webgl' : 'canvas',
        kernels: kernels().name,
        instances: gl ? gl.fullSize : scene.nodeCount + scene.edgeCount,
        drawn: lastDrawn,
        lodZoom: lastLevel,
        frameMs,
      }
    },
    setScene(next) {
      source = next
      scene = { ...next }
      syncView()
      maxOwnRadiusCache = null
      // Indices of the old scene mean nothing in the new one.
      hoverNode = -1
      hoverEdge = -1
      // Re-project even for the same object: coordinates may have been rewritten in place.
      unitScene = null
      projScene = null
      grid = null
      gridBuilderScene = null
      dropSimplifier()
      pathKeepKey = ''
      glGeometryStale = true
      styles = resolveStyles()
      scheduleRedraw()
    },
    restyle(next) {
      if (next) opts.styles = next
      syncView()
      maxOwnRadiusCache = null
      styles = resolveStyles()
      glStylesStale = true
      scheduleRedraw()
    },
    redraw: scheduleRedraw,
    setOptions(next) {
      const lodChanged = 'lod' in next && next.lod !== opts.lod
      Object.assign(opts, next)
      if (next.tooltipClassName) tooltip.className = next.tooltipClassName
      if ('styles' in next) {
        styles = resolveStyles()
        glStylesStale = true
      }
      if (lodChanged) {
        stopLod()
        glGeometryStale = true
      }
      scheduleRedraw()
    },
    queryBox(x0, y0, x1, y1) {
      const lx = Math.min(x0, x1)
      const hx = Math.max(x0, x1)
      const ly = Math.min(y0, y1)
      const hy = Math.max(y0, y1)
      return queryNodes((x, y) => x >= lx && x <= hx && y >= ly && y <= hy)
    },
    queryPolygon(points) {
      if (points.length < 3) return new Uint32Array(0)
      return queryNodes((x, y) => pointInPolygon(x, y, points))
    },
    setFilter(next) {
      filter = next && (next.nodes || next.edges) ? { ...next } : null
      syncView()
      hoverNode = -1
      hoverEdge = -1
      glStylesStale = true
      lodRebin = true
      scheduleRedraw()
    },
    pick(x, y) {
      const ni = nodeAt(x, y)
      if (ni >= 0) return { kind: 'node', index: ni }
      const ei = edgeAt(x, y)
      return ei >= 0 ? { kind: 'edge', index: ei } : null
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      if (frame) caf(frame)
      if (hoverFrame) caf(hoverFrame)
      offKernels()
      detach()
      adapter.cursorTarget.style.cursor = ''
      stopLod()
      gl?.dispose()
      gl = null
      gridBuilder?.dispose()
      gridBuilder = null
      dropSimplifier()
      elements.base.remove()
      elements.overlay.remove()
      tooltip.remove()
    },
  }
}

/** Even–odd rule: whether `(x, y)` is inside the polygon. */
export function pointInPolygon(x: number, y: number, points: readonly (readonly [number, number])[]): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * A radius/width multiplier for a zoom: 1 from `full` up, shrinking linearly to `min` at
 * `low` and below — keeps a dense map legible when zoomed out. Defaults: full size from
 * zoom 8, half size at zoom 3. Pass as `scale: (v) => zoomScale(v.zoom)`.
 */
export function zoomScale(
  zoom: number,
  { min = 0.5, low = 3, full = 8 }: { min?: number; low?: number; full?: number } = {},
): number {
  if (full <= low) return 1
  return Math.max(min, Math.min(1, min + ((zoom - low) * (1 - min)) / (full - low)))
}
