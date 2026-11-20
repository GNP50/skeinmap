import {
  createClusterIndex,
  createGraphLayer,
  createPanZoomAdapter,
  cssVar,
  curvedPath,
  getKernelPreference,
  greatCirclePath,
  HIDDEN,
  initWasm,
  MERCATOR,
  mercatorUnit,
  memoByTheme,
  observeTheme,
  parallelCurvature,
  rgba,
  sceneBounds,
  sceneFromGeoJSON,
  sceneToGeoJSON,
  setKernelPreference,
  tooltipCard,
  wasmError,
  wasmStatus,
  zoomScale,
  type ClusterIndex,
  type ClusterView,
  type GraphLayer,
  type KernelPreference,
  type MapAdapter,
  type Scene,
  type SceneStyles,
} from 'skeinmap'
import type * as Leaflet from 'leaflet'
import 'skeinmap/style.css'
import './style.css'
import { buildSyntheticGraph, EDGE, haversineKm, NODE, type SyntheticGraph } from './synthetic'

type AdapterKind = 'standalone' | 'leaflet' | 'maplibre'
type RendererKind = 'auto' | 'webgl' | 'canvas'
type Box = { x0: number; y0: number; x1: number; y1: number }

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
const stage = $<HTMLDivElement>('#stage')
const statsEl = $<HTMLDListElement>('#stats')
const selectionEl = $<HTMLParagraphElement>('#selection')
const busyEl = $<HTMLDivElement>('#busy')
const importButton = $<HTMLButtonElement>('#import')
const box = {
  labels: $<HTMLInputElement>('#labels'),
  hideMinor: $<HTMLInputElement>('#hide-minor'),
  degreeColour: $<HTMLInputElement>('#degree-colour'),
  arrows: $<HTMLInputElement>('#arrows'),
  clusters: $<HTMLInputElement>('#clusters'),
  worldCopies: $<HTMLInputElement>('#world-copies'),
  worker: $<HTMLInputElement>('#worker'),
}

const radio = (name: string) => (document.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement).value
const fmt = (n: number) => n.toLocaleString('en-US')

// ── WebAssembly ─────────────────────────────────────────────────────────────────
/**
 * The .wasm built from this repository (an emitted asset in the production build). An
 * installed package needs no argument: `initWasm()` finds the file next to its own module
 * in `dist/`. Run from the sources, the binary lives in `src/wasm/pkg/`, so pass its URL.
 */
const wasmUrl = new URL('../../src/wasm/pkg/skeinmap_wasm_bg.wasm', import.meta.url).href

// Not awaited: the layer starts on the TypeScript kernels and switches by itself once the
// module is ready.
const wasmStarted = performance.now()
let wasmLine = 'loading…'
void initWasm(wasmUrl).then((ok) => {
  const ms = (performance.now() - wasmStarted).toFixed(0)
  wasmLine = ok ? `ready in ${ms} ms` : `failed (${String(wasmError())}); TypeScript fallback`
  // The layer already switched for its grid and levels; re-running the projection as well
  // makes the timings reflect the module at once.
  if (ok && layer) layer.setScene(layer.scene)
  renderStats()
})

// ── Theme and styles ────────────────────────────────────────────────────────────
const root = document.documentElement
const savedTheme = (() => {
  try {
    return localStorage.getItem('skeinmap-demo-theme')
  } catch {
    return null
  }
})()
root.dataset.theme = savedTheme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
$<HTMLButtonElement>('#theme').addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'
  try {
    localStorage.setItem('skeinmap-demo-theme', root.dataset.theme)
  } catch {
    // Storage blocked: the switch still applies to this page.
  }
})

/** The style table, from CSS custom properties, re-resolved only when the theme or the
 *  arrows toggle changes. */
const styles = memoByTheme(
  (): SceneStyles => {
    const selected = cssVar('--demo-selected', '#db2777')
    const ring = cssVar('--demo-ring', '#fff')
    return {
      nodes: [
        { radius: 2.4, fill: cssVar('--demo-node', '#0e7490') },
        { radius: 5.5, fill: cssVar('--demo-hub', '#9a3412'), stroke: ring, strokeWidth: 1.5 },
        { radius: 7, fill: selected, stroke: ring, strokeWidth: 2 },
        { radius: 3.6, fill: selected },
        { radius: 4.2, fill: cssVar('--demo-boxed', '#2563eb'), stroke: ring, strokeWidth: 1 },
      ],
      edges: [
        { color: cssVar('--demo-edge', '#64748b'), width: 0.8, opacity: 0.55 },
        {
          color: cssVar('--demo-backbone', '#c2410c'),
          width: 2.2,
          opacity: 0.9,
          ...(box.arrows.checked ? { arrow: 10 } : {}),
        },
        { color: cssVar('--demo-route', '#7c3aed'), width: 1.1, opacity: 0.75 },
        { color: selected, width: 2.4 },
      ],
    }
  },
  () => `${root.dataset.theme ?? ''}|${box.arrows.checked}`,
)
const overlayColors = () => ({
  text: cssVar('--demo-label', '#111'),
  halo: cssVar('--demo-halo', 'rgba(255,255,255,0.9)'),
  accent: cssVar('--accent', '#2563eb'),
})

// ── Datasets ────────────────────────────────────────────────────────────────────
/** What the layer needs to describe a scene's elements, whatever the scene came from. */
interface Dataset {
  name: string
  scene: Scene
  degree: Uint32Array
  label(i: number): string | null
  priority(i: number): number
  nodeTooltip(i: number): string
  edgeTooltip(e: number): string
  /** Hubs and nodes with four links or more: the filter's mask (1 visible, 0 hidden). */
  majorMask: Uint8Array
  /** Per-node colours by degree, built on first use. */
  degreeColours?: Uint32Array
  buildMs: number
}

function degreesOf(scene: Scene): Uint32Array {
  const d = new Uint32Array(scene.nodeCount)
  for (let e = 0; e < scene.edgeCount; e++) {
    d[scene.edgeFrom[e]]++
    d[scene.edgeTo[e]]++
  }
  return d
}

function majorMaskOf(scene: Scene, degree: Uint32Array): Uint8Array {
  const mask = new Uint8Array(scene.nodeCount)
  for (let i = 0; i < scene.nodeCount; i++) mask[i] = degree[i] >= 4 || scene.nodeStyle[i] === NODE.hub ? 1 : 0
  return mask
}

/** A five-step ramp from few links to many, as `0xRRGGBBAA` colours. */
function degreeColoursOf(degree: Uint32Array): Uint32Array {
  const ramp = [rgba(148, 163, 184), rgba(56, 189, 248), rgba(34, 197, 94), rgba(234, 179, 8), rgba(239, 68, 68)]
  const out = new Uint32Array(degree.length)
  for (let i = 0; i < degree.length; i++) out[i] = ramp[Math.min(ramp.length - 1, Math.max(0, degree[i] - 1))]
  return out
}

function syntheticDataset(g: SyntheticGraph): Dataset {
  const name = (i: number) => {
    const city = g.cities[g.nodeCity[i]].name
    return g.localIndex[i] === 0 ? city : `${city} ${g.localIndex[i]}`
  }
  return {
    name: 'synthetic graph',
    scene: g.scene,
    degree: g.degree,
    buildMs: g.buildMs,
    majorMask: majorMaskOf(g.scene, g.degree),
    label: name,
    // Hubs win collisions and stay candidates in dense views; other nodes are named only
    // when few enough are in view.
    priority: (i) => (g.localIndex[i] === 0 ? 2 : 0),
    nodeTooltip: (i) =>
      tooltipCard(
        name(i),
        [
          ['index', fmt(i)],
          ['links', String(g.degree[i])],
          ['lon, lat', `${g.scene.nodeX[i].toFixed(3)}, ${g.scene.nodeY[i].toFixed(3)}`],
        ],
        g.localIndex[i] === 0 ? 'hub' : `node in ${g.cities[g.nodeCity[i]].name}`,
      ),
    edgeTooltip: (e) => {
      const s = g.scene
      const a = s.edgeFrom[e]
      const b = s.edgeTo[e]
      const kind =
        s.edgeStyle[e] === EDGE.backbone ? 'backbone' : s.edgeStyle[e] === EDGE.route ? 'routed link' : 'link'
      return tooltipCard(
        `Edge #${fmt(e)}`,
        [
          ['from', name(a)],
          ['to', name(b)],
          ['straight-line', `${haversineKm(s.nodeX[a], s.nodeY[a], s.nodeX[b], s.nodeY[b]).toFixed(1)} km`],
        ],
        kind,
      )
    },
  }
}

/**
 * The "Import GeoJSON" dataset: a small synthetic graph exported with `sceneToGeoJSON`,
 * given names and a few extra links (parallel curved edges, great-circle arcs), serialised
 * to text and read back with `sceneFromGeoJSON` — what loading a file would do.
 */
function importedDataset(): Dataset {
  const t0 = performance.now()
  const small = buildSyntheticGraph(3000, 21)
  const collection = sceneToGeoJSON(small.scene)
  const hubs = small.cities.map((c) => c.hub)
  for (const f of collection.features) {
    if (f.geometry.type !== 'Point') continue
    const i = f.properties.index
    const city = small.cities[small.nodeCity[i]].name
    ;(f.properties as Record<string, unknown>).name =
      small.localIndex[i] === 0 ? city : `${city} ${small.localIndex[i]}`
  }
  type Extra = {
    type: 'Feature'
    geometry: { type: 'LineString'; coordinates: number[][] }
    properties: Record<string, unknown>
  }
  const extra: Extra[] = []
  const line = (flat: number[], style: number, kind: string) => {
    const coordinates: number[][] = []
    for (let p = 0; p + 1 < flat.length; p += 2) coordinates.push([flat[p], flat[p + 1]])
    extra.push({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { style, kind } })
  }
  const at = (i: number): [number, number] => [small.scene.nodeX[i], small.scene.nodeY[i]]
  // Three parallel links between pairs of hubs, fanned out with curvedPath.
  for (let h = 0; h + 1 < 10; h += 2) {
    const [ax, ay] = at(hubs[h])
    const [bx, by] = at(hubs[h + 1])
    for (let k = 0; k < 3; k++) line(curvedPath(ax, ay, bx, by, parallelCurvature(k, 3)), EDGE.route, 'parallel link')
  }
  // Long links along great circles.
  for (let h = 0; h < 6; h++) {
    const [ax, ay] = at(hubs[h])
    const [bx, by] = at(hubs[hubs.length - 1 - h])
    line(greatCirclePath(ax, ay, bx, by, 48), EDGE.backbone, 'great-circle link')
  }
  const text = JSON.stringify({ ...collection, features: [...collection.features, ...extra] })

  type Props = { name?: string; style?: number; kind?: string }
  type Feature = { geometry: { type: string; coordinates?: unknown } | null; properties: Props | null }
  const parsed = JSON.parse(text) as { type: string; features: Feature[] }
  const { scene, nodeFeature, edgeFeature } = sceneFromGeoJSON(parsed, {
    nodeStyle: (f) => Number(f.properties?.style ?? 0),
    edgeStyle: (f) => Number(f.properties?.style ?? 0),
  })
  const props = (index: number): Props => parsed.features[index]?.properties ?? {}
  const degree = degreesOf(scene)
  const label = (i: number) => (nodeFeature[i] >= 0 ? (props(nodeFeature[i]).name ?? null) : null)
  return {
    name: `imported GeoJSON (${fmt(parsed.features.length)} features)`,
    scene,
    degree,
    buildMs: performance.now() - t0,
    majorMask: majorMaskOf(scene, degree),
    label,
    priority: (i) => (scene.nodeStyle[i] === NODE.hub ? 2 : 0),
    nodeTooltip: (i) =>
      tooltipCard(label(i) ?? `Node #${i}`, [
        ['feature', String(nodeFeature[i])],
        ['links', String(degree[i])],
      ]),
    edgeTooltip: (e) =>
      tooltipCard(`Edge #${fmt(e)}`, [
        ['feature', String(edgeFeature[e])],
        ['kind', props(edgeFeature[e]).kind ?? 'link'],
      ]),
  }
}

// ── State ───────────────────────────────────────────────────────────────────────
let graph: Dataset | null = null
let imported: Dataset | null = null
let showImported = false
const data = () => (showImported ? imported : graph)

let layer: GraphLayer | null = null
let adapter: MapAdapter | null = null
let teardownAdapter: (() => void) | null = null
let fit: (() => void) | null = null
let mountToken = 0

/** Clusters of the current dataset, recomputed when the integer zoom changes. */
let clusterIndex: ClusterIndex | null = null
let clusters: { zoom: number; view: ClusterView } | null = null

// ── Highlights (selection and box selection) ────────────────────────────────────
/** Style bytes and colours the highlight overwrote, restored before the next one. */
let restore: { nodes: [number, number, number][]; edges: [number, number][] } = { nodes: [], edges: [] }
let selected = -1

function clearHighlight() {
  const d = data()
  if (!d) return
  const s = d.scene
  for (const [i, style, colour] of restore.nodes) {
    s.nodeStyle[i] = style
    if (s.nodeColor) s.nodeColor[i] = colour
  }
  for (const [e, style] of restore.edges) s.edgeStyle[e] = style
  restore = { nodes: [], edges: [] }
  selected = -1
}

/** Restyle node `i` as `style`, remembering what it was. A per-node colour would win
 *  over the style's fill, so it is cleared while the node is highlighted. */
function paintNode(s: Scene, i: number, style: number) {
  restore.nodes.push([i, s.nodeStyle[i], s.nodeColor ? s.nodeColor[i] : 0])
  s.nodeStyle[i] = style
  if (s.nodeColor) s.nodeColor[i] = 0
}

function select(index: number) {
  const d = data()
  if (!d || !layer) return
  const again = index === selected
  clearHighlight()
  if (!again) {
    // A selection is a few byte writes plus restyle(): no geometry is rebuilt.
    const s = d.scene
    selected = index
    paintNode(s, index, NODE.selected)
    for (let e = 0; e < s.edgeCount; e++) {
      const a = s.edgeFrom[e]
      const b = s.edgeTo[e]
      if (a !== index && b !== index) continue
      restore.edges.push([e, s.edgeStyle[e]])
      s.edgeStyle[e] = EDGE.selected
      const other = a === index ? b : a
      if (s.nodeStyle[other] === NODE.plain) paintNode(s, other, NODE.neighbour)
    }
  }
  layer.restyle()
  selectionEl.textContent =
    selected < 0
      ? 'Nothing selected.'
      : `Node #${fmt(selected)}, ${d.label(selected) ?? ''}, ${d.degree[selected]} links. Click it again to clear.`
}

function selectBox(b: Box) {
  const d = data()
  if (!d || !layer) return
  // Visible nodes only: hidden (filtered) nodes are never returned.
  const hits = layer.queryBox(b.x0, b.y0, b.x1, b.y1)
  if (clusters) {
    let members = 0
    for (const c of hits) members += clusters.view.counts[c]
    selectionEl.textContent = `${fmt(hits.length)} clusters in the box, ${fmt(members)} nodes.`
    return
  }
  clearHighlight()
  for (const i of hits) paintNode(d.scene, i, NODE.boxed)
  layer.restyle()
  selectionEl.textContent = `${fmt(hits.length)} nodes in the box. Press Escape or Clear to reset.`
}

function clearSelection() {
  clearHighlight()
  layer?.restyle()
  selectionEl.textContent = 'Nothing selected.'
}

// ── Filters, colours, clusters ──────────────────────────────────────────────────
function applyFilter() {
  const d = data()
  if (!d || !layer) return
  // In cluster mode the filter is built into the cluster index instead (hidden nodes join
  // no cluster); a mask belongs to one scene, so the cluster scene gets none.
  layer.setFilter(!clusters && box.hideMinor.checked ? { nodes: d.majorMask } : null)
}

function applyColours() {
  const d = data()
  if (!d) return
  if (box.degreeColour.checked) {
    d.degreeColours ??= degreeColoursOf(d.degree)
    d.scene.nodeColor = d.degreeColours
    // Highlighted nodes keep their highlight colour; restoring gives them their own back.
    for (const n of restore.nodes) {
      n[2] = d.degreeColours[n[0]]
      d.scene.nodeColor[n[0]] = 0
    }
  } else {
    if (d.scene.nodeColor) for (const n of restore.nodes) d.scene.nodeColor[n[0]] = n[2]
    d.scene.nodeColor = undefined
  }
  layer?.restyle()
}

/** Integer zoom of the view: one unit is `2^zoom` pixels, the unit of the cluster index. */
const viewZoom = () => (adapter ? Math.max(0, Math.min(24, Math.floor(Math.log2(adapter.getViewport().k)))) : 0)

function rebuildClusterIndex() {
  clusterIndex?.dispose()
  clusterIndex = null
  const d = data()
  if (!d || !box.clusters.checked) return
  // The filter, as hidden style bytes: hidden nodes join no cluster.
  const nodeStyle = Uint8Array.from(d.scene.nodeStyle)
  if (box.hideMinor.checked) for (let i = 0; i < nodeStyle.length; i++) if (!d.majorMask[i]) nodeStyle[i] = HIDDEN
  clusterIndex = createClusterIndex({ ...d.scene, nodeStyle })
}

/** Show the clusters of the current integer zoom, or the dataset itself. */
function updateClusters(force = false) {
  const d = data()
  if (!d || !layer) return
  if (!clusterIndex) {
    if (clusters) {
      clusters = null
      layer.setScene(d.scene)
      applyFilter()
    }
    return
  }
  const zoom = viewZoom()
  if (!force && clusters && clusters.zoom === zoom) return
  const view = clusterIndex.level(zoom)
  // Size clusters by member count (per-node radius); single nodes keep the style's.
  if (!view.scene.nodeRadius) {
    const radius = new Float32Array(view.scene.nodeCount)
    for (let c = 0; c < radius.length; c++) if (view.counts[c] > 1) radius[c] = 4 + 2.2 * Math.log2(view.counts[c])
    view.scene.nodeRadius = radius
  }
  const wasClustered = clusters !== null
  clusters = { zoom, view }
  if (!wasClustered) layer.setFilter(null)
  layer.setScene(view.scene)
}

// ── Layer ───────────────────────────────────────────────────────────────────────
/** The callbacks read the current mode on every call, so switching between the dataset
 *  and its clusters needs no setOptions. */
function createLayer(a: MapAdapter, d: Dataset): GraphLayer {
  return createGraphLayer(a, {
    scene: clusters ? clusters.view.scene : d.scene,
    styles,
    renderer: radio('renderer') as RendererKind,
    worldCopies: box.worldCopies.checked,
    scale: (view) => zoomScale(view.zoom, { min: 0.45, low: 3, full: 9 }),
    labels: box.labels.checked,
    overlayColors,
    nodeLabel: (i) => {
      if (!clusters) return d.label(i)
      const n = clusters.view.counts[i]
      return n > 1 ? fmt(n) : d.label(clusters.view.members(i)[0])
    },
    labelPriority: (i) => (clusters ? (clusters.view.counts[i] > 1 ? 2 : 0) : d.priority(i)),
    tooltipHtml: true,
    nodeTooltip: (i) => {
      if (!clusters) return d.nodeTooltip(i)
      const members = clusters.view.members(i)
      if (members.length === 1) return d.nodeTooltip(members[0])
      const names = Array.from(members.subarray(0, 3), (m) => d.label(m) ?? `#${m}`)
      return tooltipCard(
        `Cluster of ${fmt(members.length)} nodes`,
        [
          ['zoom', String(clusters.zoom)],
          ['first members', names.join(', ')],
        ],
        'zoom in to split it',
      )
    },
    edgeTooltip: (e) => (clusters ? tooltipCard('Links between two clusters', [['edge', fmt(e)]]) : d.edgeTooltip(e)),
    onNodeClick: (i) => {
      if (!clusters) return select(i)
      const n = clusters.view.counts[i]
      selectionEl.textContent = `Cluster #${fmt(i)} at zoom ${clusters.zoom}: ${fmt(n)} node${n === 1 ? '' : 's'}.`
    },
    lod: box.worker.checked
      ? {
          worker: () => {
            const w = new Worker(new URL('../../src/lod-worker.ts', import.meta.url), { type: 'module' })
            // The worker has its own module instance: load the WASM kernels there too,
            // unless the TypeScript kernels were asked for.
            if (getKernelPreference() !== 'ts') w.postMessage({ type: 'wasm', url: wasmUrl })
            return w
          },
        }
      : true,
  })
}

/** Unit bounds of the scene under the Mercator projection (for the standalone view). */
function mercatorBounds(scene: Scene): [number, number, number, number] {
  const b = sceneBounds(scene) ?? [0, 0, 0, 0]
  const ux = new Float64Array(2)
  const uy = new Float64Array(2)
  mercatorUnit(b[0], b[1], ux, uy, 0)
  mercatorUnit(b[2], b[3], ux, uy, 1)
  return [Math.min(ux[0], ux[1]), Math.min(uy[0], uy[1]), Math.max(ux[0], ux[1]), Math.max(uy[0], uy[1])]
}

/**
 * Shift-drag box selection over a map, with plain pointer events. Listening on the stage
 * in the capture phase sees the press before the map does, so the map neither pans nor
 * box-zooms. (The standalone view has this built in: `onBoxSelect`.)
 */
function shiftDragBox(target: HTMLElement, onBox: (b: Box) => void): () => void {
  let start: [number, number] | null = null
  let rect: HTMLDivElement | null = null
  const local = (e: PointerEvent): [number, number] => {
    const r = target.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const place = (p: [number, number]) => {
    if (!start || !rect) return
    rect.style.left = `${Math.min(start[0], p[0])}px`
    rect.style.top = `${Math.min(start[1], p[1])}px`
    rect.style.width = `${Math.abs(p[0] - start[0])}px`
    rect.style.height = `${Math.abs(p[1] - start[1])}px`
  }
  const down = (e: PointerEvent) => {
    if (!e.shiftKey || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    start = local(e)
    rect = document.createElement('div')
    rect.className = 'skeinmap-selection'
    Object.assign(rect.style, { position: 'absolute', pointerEvents: 'none', zIndex: '1500' })
    target.appendChild(rect)
    place(start)
    target.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent) => {
    if (!start) return
    e.stopPropagation()
    place(local(e))
  }
  const up = (e: PointerEvent) => {
    if (!start) return
    e.stopPropagation()
    const p = local(e)
    rect?.remove()
    onBox({ x0: start[0], y0: start[1], x1: p[0], y1: p[1] })
    start = null
    rect = null
  }
  // Leaflet also listens to mousedown: keep a shift-press away from it.
  const swallow = (e: MouseEvent) => {
    if (e.shiftKey) e.stopPropagation()
  }
  target.addEventListener('pointerdown', down, true)
  target.addEventListener('pointermove', move, true)
  target.addEventListener('pointerup', up, true)
  target.addEventListener('mousedown', swallow, true)
  return () => {
    target.removeEventListener('pointerdown', down, true)
    target.removeEventListener('pointermove', move, true)
    target.removeEventListener('pointerup', up, true)
    target.removeEventListener('mousedown', swallow, true)
    rect?.remove()
  }
}

async function mount() {
  const token = ++mountToken
  unmount()
  const d = data()
  if (!d) return
  const host = document.createElement('div')
  stage.replaceChildren(host)
  const kind = radio('adapter') as AdapterKind
  const teardown: (() => void)[] = []

  if (kind === 'standalone') {
    const a = createPanZoomAdapter(host, {
      projection: MERCATOR,
      minK: 1,
      maxK: 2 ** 22,
      onReset: () => fit?.(),
      onBoxSelect: selectBox,
    })
    adapter = a
    fit = () => a.fitBounds(mercatorBounds(d.scene), 24)
    fit()
    teardown.push(a.onViewChange(() => updateClusters()))
    teardown.push(() => a.dispose())
  } else if (kind === 'leaflet') {
    const [leaflet, { leafletAdapter, fitScene }] = await Promise.all([
      import('leaflet'),
      import('skeinmap/leaflet'),
      import('leaflet/dist/leaflet.css'),
    ])
    if (token !== mountToken) return
    // Leaflet 1.9 ships CommonJS/UMD: depending on the interop the namespace is on `default`.
    const L = (leaflet as unknown as { default?: typeof Leaflet }).default ?? (leaflet as unknown as typeof Leaflet)
    // Shift-drag is ours (box selection), not Leaflet's box zoom.
    const map = L.map(host, { zoomControl: true, boxZoom: false, minZoom: 1 })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map)
    fitScene(L, map, d.scene, { animate: false })
    adapter = leafletAdapter(L, map)
    fit = () => fitScene(L, map, d.scene)
    map.on('zoomend', () => updateClusters())
    teardown.push(shiftDragBox(stage, selectBox))
    teardown.push(() => map.remove())
  } else {
    const [maplibregl, { maplibreAdapter, fitScene }, { default: maplibreWorker }] = await Promise.all([
      import('maplibre-gl'),
      import('skeinmap/maplibre'),
      // MapLibre 6 finds its worker next to its own module at runtime, which a bundler does
      // not see: hand it the URL of the emitted file.
      import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
      import('maplibre-gl/dist/maplibre-gl.css'),
    ])
    if (token !== mountToken) return
    maplibregl.setWorkerUrl(maplibreWorker)
    const map = new maplibregl.Map({
      container: host,
      style: 'https://demotiles.maplibre.org/style.json',
      center: [11, 47],
      zoom: 3,
      // The overlay is drawn flat: no pitch.
      maxPitch: 0,
      pitchWithRotate: false,
      touchPitch: false,
      boxZoom: false,
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: false }))
    fitScene(map, d.scene)
    adapter = maplibreAdapter(map)
    fit = () => fitScene(map, d.scene, { duration: 300 })
    map.on('zoomend', () => updateClusters())
    teardown.push(shiftDragBox(stage, selectBox))
    teardown.push(() => map.remove())
  }
  teardownAdapter = () => {
    for (const t of teardown) t()
  }
  clusters = null
  rebuildClusterIndex()
  layer = createLayer(adapter, d)
  updateClusters(true)
  applyFilter()
  // Re-apply highlights and colours made before a remount (they live in the scene).
  layer.restyle()
}

function unmount() {
  layer?.destroy()
  layer = null
  teardownAdapter?.()
  teardownAdapter = null
  adapter = null
  fit = null
}

// ── Scene ───────────────────────────────────────────────────────────────────────
async function rebuild() {
  busyEl.hidden = false
  // Let the "building" note paint before the synchronous build.
  await new Promise((r) => setTimeout(r, 30))
  clearHighlight()
  selectionEl.textContent = 'Nothing selected.'
  graph = syntheticDataset(buildSyntheticGraph(Number(radio('size'))))
  showImported = false
  importButton.textContent = 'Import GeoJSON'
  applyColours()
  busyEl.hidden = true
  // A new layer rather than setScene(): the callbacks close over the dataset's lookups.
  await mount()
  renderStats()
}

async function toggleImport() {
  clearHighlight()
  selectionEl.textContent = 'Nothing selected.'
  showImported = !showImported
  if (showImported) imported ??= importedDataset()
  importButton.textContent = showImported ? 'Back to the synthetic graph' : 'Import GeoJSON'
  applyColours()
  await mount()
  renderStats()
}

// ── Stats ───────────────────────────────────────────────────────────────────────
function renderStats() {
  const rows: [string, string][] = []
  const d = data()
  if (d) {
    const s = d.scene
    rows.push(['showing', clusters ? `clusters at zoom ${clusters.zoom}` : d.name])
    rows.push(['nodes', fmt(s.nodeCount)])
    rows.push(['edges', fmt(s.edgeCount)])
    if (clusters) rows.push(['clusters', fmt(clusters.view.scene.nodeCount)])
    if (box.hideMinor.checked) {
      let visible = 0
      for (let i = 0; i < d.majorMask.length; i++) visible += d.majorMask[i]
      rows.push(['visible nodes', fmt(visible)])
    }
    rows.push(['path points', fmt(s.pathX?.length ?? 0)])
    rows.push(['scene build', `${d.buildMs.toFixed(0)} ms`])
  }
  const st = layer?.stats
  if (st) {
    rows.push(['backend', st.backend])
    rows.push(['kernels', st.kernels])
    rows.push(['instances', fmt(st.instances)])
    rows.push(['drawn', fmt(st.drawn)])
    rows.push(['LOD zoom', st.lodZoom === null ? 'full scene' : String(st.lodZoom)])
    rows.push(['frame', `${st.frameMs.toFixed(2)} ms`])
  }
  rows.push(['WASM init', wasmStatus() === 'loading' ? 'loading…' : wasmLine])
  rows.push(['preference', getKernelPreference()])
  statsEl.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt')
      dt.textContent = k
      const dd = document.createElement('dd')
      dd.textContent = v
      return [dt, dd]
    }),
  )
}
setInterval(renderStats, 300)

// ── Controls ────────────────────────────────────────────────────────────────────
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="size"]')) {
  input.addEventListener('change', () => void rebuild())
}
for (const name of ['adapter', 'renderer']) {
  for (const input of document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
    input.addEventListener('change', () => void mount())
  }
}
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="kernels"]')) {
  input.addEventListener('change', () => {
    setKernelPreference(radio('kernels') as KernelPreference)
    // The layer rebuilds its grid and levels by itself; setScene also re-runs the
    // projection, so every kernel shows up in the timings.
    if (layer) layer.setScene(layer.scene)
    // A worker loads its own kernels: recreate it with the new preference.
    if (box.worker.checked) void mount()
  })
}
$<HTMLButtonElement>('#fit').addEventListener('click', () => fit?.())
$<HTMLButtonElement>('#clear').addEventListener('click', clearSelection)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') clearSelection()
})
importButton.addEventListener('click', () => void toggleImport())
box.labels.addEventListener('change', () => layer?.setOptions({ labels: box.labels.checked }))
box.worldCopies.addEventListener('change', () => layer?.setOptions({ worldCopies: box.worldCopies.checked }))
box.worker.addEventListener('change', () => void mount())
box.arrows.addEventListener('change', () => layer?.restyle())
box.degreeColour.addEventListener('change', applyColours)
box.hideMinor.addEventListener('change', () => {
  if (clusters) {
    rebuildClusterIndex()
    updateClusters(true)
  } else applyFilter()
})
box.clusters.addEventListener('change', () => {
  clearSelection()
  rebuildClusterIndex()
  updateClusters(true)
})

observeTheme(() => {
  layer?.restyle()
})

void rebuild()
