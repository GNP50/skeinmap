import {
  createGraphLayer,
  createPanZoomAdapter,
  initWasm,
  MERCATOR,
  wasmStatus,
  type GraphLayer,
  type PanZoomAdapter,
  type Scene,
  type SceneStyles,
} from 'skeinmap'
// The package's own worker module as the worker entry. (The two-line recipe of
// docs/guide/frameworks.md, `import 'skeinmap/lod-worker'` inside a worker file, is
// tree-shaken away by Vite's production build because the package declares
// `"sideEffects": ["*.css"]`, which leaves a worker that never answers.)
import LodWorker from 'skeinmap/lod-worker?worker'
import wasmUrl from 'skeinmap/wasm?url'
import {
  EDGE_COLOR,
  EDGE_WIDTH,
  HIGHLIGHT_COLOR,
  NODE_COLOR,
  NODE_RADIUS,
  nextFrame,
  run,
  toUnits,
} from '../../src/harness'

const renderer = new URLSearchParams(location.search).get('renderer') === 'canvas' ? 'canvas' : 'webgl'

const styles: SceneStyles = {
  nodes: [
    { radius: NODE_RADIUS, fill: NODE_COLOR },
    { radius: NODE_RADIUS, fill: HIGHLIGHT_COLOR },
  ],
  edges: [{ color: EDGE_COLOR, width: EDGE_WIDTH }],
}

let adapter: PanZoomAdapter
let layer: GraphLayer
let scene: Scene
let wasmMs = 0
let lodLevels = 0
let cameraFrames = 0

run({
  name: renderer === 'canvas' ? 'skeinmap (Canvas 2D)' : 'skeinmap (WebGL2)',
  version: __VERSIONS__.skeinmap,
  async setup(host, cam) {
    const t0 = performance.now()
    // Loaded before the data is ready, so the layer starts on the WebAssembly kernels.
    await initWasm()
    wasmMs = performance.now() - t0
    adapter = createPanZoomAdapter(host, { projection: MERCATOR, minK: 1, maxK: 2 ** 22 })
    const [ux, uy] = toUnits(cam.lon, cam.lat)
    adapter.setView(ux, uy, 2 ** cam.zoom)
    layer = createGraphLayer(adapter, {
      styles,
      renderer,
      labels: false,
      lod:
        renderer === 'webgl'
          ? {
              worker: () => {
                const w = new LodWorker()
                // The worker has its own module instance: load the WebAssembly kernels there too.
                w.postMessage({ type: 'wasm', url: wasmUrl })
                return w
              },
            }
          : false,
    })
    await nextFrame()
  },
  async load(g) {
    // The dataset is already flat typed arrays in longitude/latitude: a Scene as is.
    scene = {
      nodeCount: g.nodeCount,
      nodeX: g.lon,
      nodeY: g.lat,
      nodeStyle: new Uint8Array(g.nodeCount),
      edgeCount: g.edgeCount,
      edgeFrom: g.from,
      edgeTo: g.to,
      edgeStyle: new Uint8Array(g.edgeCount),
    }
    layer.setScene(scene)
    // setScene repaints on the next animation frame, ahead of this callback.
    await nextFrame()
  },
  setCamera(c) {
    const [ux, uy] = toUnits(c.lon, c.lat)
    adapter.setView(ux, uy, 2 ** c.zoom) // repaints synchronously
    cameraFrames++
    if (layer.stats.lodZoom !== null) lodLevels++
  },
  async restyle(nodes, on) {
    const s = on ? 1 : 0
    for (let j = 0; j < nodes.length; j++) scene.nodeStyle[nodes[j]] = s
    layer.restyle()
    await nextFrame()
  },
  pick(x, y) {
    return layer.pick(x, y) !== null
  },
  surfaces() {
    const c = document.querySelector('canvas.skeinmap-base') as HTMLCanvasElement
    return [{ canvas: c, kind: layer.backend === 'webgl' ? 'webgl' : '2d' }]
  },
  info() {
    return { ...layer.stats, wasm: wasmStatus(), wasmInitMs: wasmMs, framesOnLodLevel: lodLevels, cameraFrames }
  },
})
