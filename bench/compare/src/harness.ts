/**
 * The in-page side of the benchmark, shared by every page. A page supplies an `Impl` for
 * its library; this module generates the dataset, drives the camera, the restyle and the
 * picks, and exposes the results to the Playwright driver as `window.__bench`.
 *
 * Camera convention: `zoom` is a Leaflet-style zoom (a 256 px world at zoom 0). MapLibre
 * and deck.gl use 512 px tiles, so their pages pass `zoom - 1`.
 */
import { buildGraph, type Graph } from './data'

export interface Camera {
  lon: number
  lat: number
  /** 256 px world at zoom 0. */
  zoom: number
}

export interface Surface {
  canvas: HTMLCanvasElement
  kind: 'webgl' | '2d'
}

export interface Impl {
  /** Library name and version, for the report. */
  name: string
  version: string
  /** Create the empty view (map, deck, layer without data) and wait until it is ready. */
  setup(host: HTMLElement, camera: Camera): Promise<void>
  /** Hand the dataset over; resolve once the library reports a frame with it drawn. */
  load(g: Graph): Promise<void>
  /** Move the camera now (the library repaints on its own schedule). */
  setCamera(c: Camera): void
  /** Colour `nodes` red (`on`) or back to the base colour; resolve once the library reports
   *  the frame with the change drawn. */
  restyle(nodes: Uint32Array, on: boolean): Promise<void>
  /** Programmatic pick at container pixel (x, y): true when something was found. */
  pick?(x: number, y: number): boolean | Promise<boolean>
  /** Why picking is not measured, when `pick` is absent. */
  pickSkipped?: string
  /** Canvases the library draws into (for the GPU/raster sync, see `sync`). */
  surfaces(): Surface[]
  /** Resolve when background work (tiles, levels of detail) has settled. */
  idle?(): Promise<void>
  /** Library-specific diagnostics for the report. */
  info?(): Record<string, unknown>
}

export const NODE_COLOR = '#0e7490'
export const NODE_COLOR_RGB: [number, number, number] = [14, 116, 144]
export const HIGHLIGHT_COLOR = '#dc2626'
export const HIGHLIGHT_COLOR_RGB: [number, number, number] = [220, 38, 38]
export const EDGE_COLOR = '#64748b'
export const EDGE_COLOR_RGB: [number, number, number] = [100, 116, 139]
/** Node disc radius and edge width, in CSS pixels. */
export const NODE_RADIUS = 3
export const EDGE_WIDTH = 1

// ── Web Mercator in 256 px units (zoom 0) ─────────────────────────────────────
const MAX_LAT = 85.0511287798
export function toUnits(lon: number, lat: number): [number, number] {
  const c = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))
  const s = Math.sin((c * Math.PI) / 180)
  return [256 * (0.5 + lon / 360), 256 * (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI))]
}
export function fromUnits(ux: number, uy: number): [number, number] {
  const lon = (ux / 256 - 0.5) * 360
  const n = Math.PI - (2 * Math.PI * uy) / 256
  return [lon, (180 / Math.PI) * Math.atan(Math.sinh(n))]
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}
export function summary(values: number[]) {
  const s = [...values].sort((a, b) => a - b)
  return { median: quantile(s, 0.5), p95: quantile(s, 0.95), min: s[0], max: s[s.length - 1], count: s.length }
}

export function run(impl: Impl) {
  const params = new URLSearchParams(location.search)
  const elements = Number(params.get('n') ?? 100_000)
  /** Force the GPU / rasteriser to finish before a frame counts (default on). */
  const useSync = params.get('sync') !== '0'
  const W = window.innerWidth
  const H = window.innerHeight
  const host = document.getElementById('view') as HTMLElement

  const scratch = new Uint8Array(4)
  /** Wait until the drawing commands issued so far have executed: a 1×1 read-back from
   *  every canvas the library draws into. Without it, a software GL can queue work and
   *  requestAnimationFrame keeps ticking at 60 Hz while the frames are not done. */
  const sync = () => {
    if (!useSync) return
    for (const s of impl.surfaces()) {
      if (s.kind === 'webgl') {
        const gl = (s.canvas.getContext('webgl2') ?? s.canvas.getContext('webgl')) as WebGL2RenderingContext | null
        gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, scratch)
      } else {
        s.canvas.getContext('2d')?.getImageData(0, 0, 1, 1)
      }
    }
  }

  let graph: Graph
  let home: Camera
  let homeUnits: [number, number]

  const cameraAt = (i: number, frames: number): Camera => {
    // Zoom in by 3 levels and back out while the centre travels around a circle.
    const t = i / frames
    const zoom = home.zoom + 3 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t))
    const r = (0.15 * W) / Math.pow(2, home.zoom)
    const ux = homeUnits[0] + r * (Math.cos(2 * Math.PI * t) - 1)
    const uy = homeUnits[1] + r * Math.sin(2 * Math.PI * t)
    const [lon, lat] = fromUnits(ux, uy)
    return { lon, lat, zoom }
  }

  const ready = (async () => {
    const t0 = performance.now()
    graph = buildGraph(elements)
    const genMs = performance.now() - t0
    const [x0, y0] = toUnits(graph.bounds[0], graph.bounds[3])
    const [x1, y1] = toUnits(graph.bounds[2], graph.bounds[1])
    const pad = 24
    const zoom = Math.log2(Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0)))
    homeUnits = [(x0 + x1) / 2, (y0 + y1) / 2]
    const [lon, lat] = fromUnits(homeUnits[0], homeUnits[1])
    home = { lon, lat, zoom }
    const s0 = performance.now()
    await impl.setup(host, home)
    const setupMs = performance.now() - s0
    return {
      library: impl.name,
      version: impl.version,
      nodes: graph.nodeCount,
      edges: graph.edgeCount,
      genMs,
      setupMs,
      width: W,
      height: H,
      dpr: window.devicePixelRatio,
      sync: useSync,
    }
  })()

  const api = {
    ready,
    /** Data-ready → first frame with the data presented, in ms. */
    async load() {
      await ready
      const t0 = performance.now()
      await impl.load(graph)
      sync()
      await nextFrame()
      return performance.now() - t0
    },
    async settle(ms = 800) {
      await sleep(ms)
      await impl.idle?.()
      await sleep(200)
    },
    /** Visit 8 points of the animation path, letting background work finish at each: levels
     *  of detail, tiles and shaders for every zoom of the path exist before it is timed. */
    async warm(frames = 120) {
      for (let k = 0; k <= 8; k++) {
        impl.setCamera(cameraAt(Math.round((k * frames) / 8), frames))
        await nextFrame()
        sync()
        await sleep(150)
        await impl.idle?.()
        await nextFrame()
        sync()
      }
      impl.setCamera(home)
      await nextFrame()
      sync()
    },
    /** `frames` frames of continuous zoom/pan; returns the rAF intervals in ms. */
    async animate(frames = 120) {
      const stamps: number[] = []
      await new Promise<void>((resolve) => {
        let i = 0
        const step = (ts: number) => {
          sync()
          stamps.push(ts)
          if (i > frames) {
            resolve()
            return
          }
          impl.setCamera(cameraAt(i, frames))
          i++
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })
      impl.setCamera(home)
      // Interval k covers frame k's camera change being drawn (one frame of latency at most
      // for libraries that draw on their own animation frame).
      const intervals: number[] = []
      for (let k = 2; k < stamps.length; k++) intervals.push(stamps[k] - stamps[k - 1])
      return intervals
    },
    /** Recolour 1% of the nodes `reps` times (alternating on/off); ms until presented. */
    async restyle(reps = 6) {
      impl.setCamera(home)
      await sleep(300)
      const nodes = new Uint32Array(Math.floor(graph.nodeCount / 100))
      for (let j = 0; j < nodes.length; j++) nodes[j] = j * 100
      const times: number[] = []
      for (let r = 0; r < reps; r++) {
        await nextFrame()
        const t0 = performance.now()
        await impl.restyle(nodes, r % 2 === 0)
        sync()
        await nextFrame()
        times.push(performance.now() - t0)
        await sleep(100)
      }
      return { times, count: nodes.length }
    },
    /** Programmatic picks at `count` node positions of the home view. */
    async pick(count = 50) {
      if (!impl.pick) return { skipped: impl.pickSkipped ?? 'no programmatic pick' }
      impl.setCamera(home)
      await sleep(300)
      await impl.idle?.()
      const k = Math.pow(2, home.zoom)
      const times: number[] = []
      let hits = 0
      for (let j = 0; j < count; j++) {
        const i = Math.floor(((j + 0.5) * graph.nodeCount) / count)
        const [ux, uy] = toUnits(graph.lon[i], graph.lat[i])
        const x = (ux - homeUnits[0]) * k + W / 2
        const y = (uy - homeUnits[1]) * k + H / 2
        const t0 = performance.now()
        const hit = await impl.pick(x, y)
        times.push(performance.now() - t0)
        if (hit) hits++
      }
      return { times, hits, count }
    },
    info: () => impl.info?.() ?? {},
  }
  ;(window as unknown as { __bench: typeof api }).__bench = api
}

export { nextFrame, sleep }
