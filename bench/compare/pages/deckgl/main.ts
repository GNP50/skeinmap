import { Deck, MapView } from '@deck.gl/core'
import { LineLayer, ScatterplotLayer } from '@deck.gl/layers'
import {
  EDGE_COLOR_RGB,
  EDGE_WIDTH,
  HIGHLIGHT_COLOR_RGB,
  NODE_COLOR_RGB,
  NODE_RADIUS,
  run,
  type Camera,
} from '../../src/harness'

// deck.gl's MapView uses 512 px tiles: its zoom is the 256 px zoom minus one.
const viewState = (c: Camera) => ({ longitude: c.lon, latitude: c.lat, zoom: c.zoom - 1, pitch: 0, bearing: 0 })

let deck: Deck
let rendered: (() => void) | null = null
let nodeCount = 0
let positions: Float32Array
let segments: Float32Array
let colors: Uint8Array
let edgeCount = 0

const waitRender = () => new Promise<void>((r) => (rendered = r))

/** The binary-attribute fast path: no accessors run per object. */
function layers() {
  return [
    new LineLayer({
      id: 'edges',
      data: {
        length: edgeCount,
        attributes: {
          getSourcePosition: { value: segments, size: 2, stride: 16, offset: 0 },
          getTargetPosition: { value: segments, size: 2, stride: 16, offset: 8 },
        },
      },
      getColor: [...EDGE_COLOR_RGB, 255],
      getWidth: EDGE_WIDTH,
      widthUnits: 'pixels',
      pickable: true,
    }),
    new ScatterplotLayer({
      id: 'nodes',
      data: {
        length: nodeCount,
        attributes: {
          getPosition: { value: positions, size: 2 },
          getFillColor: { value: colors, size: 4 },
        },
      },
      getRadius: NODE_RADIUS,
      radiusUnits: 'pixels',
      stroked: false,
      filled: true,
      pickable: true,
    }),
  ]
}

run({
  name: 'deck.gl',
  version: __VERSIONS__['@deck.gl/core'],
  async setup(host, cam) {
    const ready = waitRender()
    deck = new Deck({
      parent: host,
      views: new MapView({ repeat: false }),
      viewState: viewState(cam),
      controller: false,
      layers: [],
      useDevicePixels: 1,
      // Same context attributes as the other WebGL pages: no multisampling.
      deviceProps: { type: 'webgl', webgl: { antialias: false, preserveDrawingBuffer: false } },
      onAfterRender: () => {
        const r = rendered
        rendered = null
        r?.()
      },
    })
    await ready
  },
  async load(g) {
    nodeCount = g.nodeCount
    edgeCount = g.edgeCount
    positions = new Float32Array(nodeCount * 2)
    for (let i = 0; i < nodeCount; i++) {
      positions[2 * i] = g.lon[i]
      positions[2 * i + 1] = g.lat[i]
    }
    segments = new Float32Array(edgeCount * 4)
    for (let e = 0; e < edgeCount; e++) {
      const a = g.from[e]
      const b = g.to[e]
      segments[4 * e] = g.lon[a]
      segments[4 * e + 1] = g.lat[a]
      segments[4 * e + 2] = g.lon[b]
      segments[4 * e + 3] = g.lat[b]
    }
    colors = new Uint8Array(nodeCount * 4)
    for (let i = 0; i < nodeCount; i++) {
      colors[4 * i] = NODE_COLOR_RGB[0]
      colors[4 * i + 1] = NODE_COLOR_RGB[1]
      colors[4 * i + 2] = NODE_COLOR_RGB[2]
      colors[4 * i + 3] = 255
    }
    deck.setProps({ layers: layers() })
    // Wait for a frame drawn after every layer has its attributes.
    for (;;) {
      await waitRender()
      if (deck.props.layers.every((l) => (l as { isLoaded: boolean }).isLoaded)) break
    }
  },
  setCamera(c) {
    deck.setProps({ viewState: viewState(c) })
  },
  async restyle(nodes, on) {
    // A new colour array (deck.gl compares binary attributes by reference).
    const next = colors.slice()
    const [r, gr, b] = on ? HIGHLIGHT_COLOR_RGB : NODE_COLOR_RGB
    for (let j = 0; j < nodes.length; j++) {
      const i = nodes[j] * 4
      next[i] = r
      next[i + 1] = gr
      next[i + 2] = b
    }
    colors = next
    const done = waitRender()
    deck.setProps({ layers: layers() })
    await done
  },
  pick(x, y) {
    return deck.pickObject({ x, y, radius: 0 }) !== null
  },
  surfaces() {
    return [{ canvas: host().querySelector('canvas') as HTMLCanvasElement, kind: 'webgl' }]
  },
  info() {
    return { renderer: 'webgl2', binaryAttributes: true }
  },
})

function host() {
  return document.getElementById('view') as HTMLElement
}
