import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { EDGE_COLOR, EDGE_WIDTH, HIGHLIGHT_COLOR, NODE_COLOR, NODE_RADIUS, nextFrame, run } from '../../src/harness'

let map: L.Map
let renderer: L.Canvas
let markers: L.CircleMarker[] = []
let clicked = false

run({
  name: 'Leaflet (canvas renderer)',
  version: L.version,
  async setup(host, cam) {
    renderer = L.canvas({ padding: 0.1 })
    map = L.map(host, {
      renderer,
      preferCanvas: true,
      zoomSnap: 0,
      zoomControl: false,
      attributionControl: false,
      zoomAnimation: false,
      fadeAnimation: false,
      markerZoomAnimation: false,
      inertia: false,
    })
    map.setView([cam.lat, cam.lon], cam.zoom, { animate: false })
    await nextFrame()
  },
  async load(g) {
    const group = L.featureGroup()
    for (let e = 0; e < g.edgeCount; e++) {
      const a = g.from[e]
      const b = g.to[e]
      L.polyline(
        [
          [g.lat[a], g.lon[a]],
          [g.lat[b], g.lon[b]],
        ],
        { renderer, color: EDGE_COLOR, weight: EDGE_WIDTH, opacity: 1, smoothFactor: 1 },
      ).addTo(group)
    }
    markers = new Array(g.nodeCount)
    for (let i = 0; i < g.nodeCount; i++) {
      markers[i] = L.circleMarker([g.lat[i], g.lon[i]], {
        renderer,
        radius: NODE_RADIUS,
        stroke: false,
        fill: true,
        fillColor: NODE_COLOR,
        fillOpacity: 1,
      }).addTo(group)
    }
    group.on('click', () => {
      clicked = true
    })
    group.addTo(map)
    // The canvas renderer redraws on its own animation frame, requested before this one.
    await nextFrame()
  },
  setCamera(c) {
    map.setView([c.lat, c.lon], c.zoom, { animate: false })
  },
  async restyle(nodes, on) {
    const fillColor = on ? HIGHLIGHT_COLOR : NODE_COLOR
    for (let j = 0; j < nodes.length; j++) markers[nodes[j]].setStyle({ fillColor })
    await nextFrame()
  },
  pick(x, y) {
    // Leaflet has no programmatic pick: dispatch a click on the renderer's canvas and see
    // whether a layer received it (the canvas renderer hit-tests synchronously).
    clicked = false
    const canvas = (renderer as unknown as { _container: HTMLCanvasElement })._container
    const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }
    canvas.dispatchEvent(new MouseEvent('click', base))
    return clicked
  },
  surfaces() {
    return [{ canvas: (renderer as unknown as { _container: HTMLCanvasElement })._container, kind: '2d' }]
  },
})
