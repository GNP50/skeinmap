import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import * as glifyModule from 'leaflet.glify'
import { EDGE_COLOR_RGB, HIGHLIGHT_COLOR_RGB, NODE_COLOR_RGB, NODE_RADIUS, nextFrame, run } from '../../src/harness'

// The package ships a UMD bundle: depending on the interop the instance is on `glify`,
// `default.glify` or `default`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ns = glifyModule as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const glify: any = ns.glify ?? ns.default?.glify ?? ns.default

type Color = { r: number; g: number; b: number; a: number }
const rgb = (c: [number, number, number]): Color => ({ r: c[0] / 255, g: c[1] / 255, b: c[2] / 255, a: 1 })
const BASE = rgb(NODE_COLOR_RGB)
const HIGHLIGHT = rgb(HIGHLIGHT_COLOR_RGB)

let map: L.Map
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let points: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lines: any
let highlighted: Uint8Array
let clicked = false

run({
  name: 'Leaflet.glify',
  version: __VERSIONS__['leaflet.glify'],
  async setup(host, cam) {
    map = L.map(host, {
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
    highlighted = new Uint8Array(g.nodeCount)
    const features = new Array(g.edgeCount)
    for (let e = 0; e < g.edgeCount; e++) {
      const a = g.from[e]
      const b = g.to[e]
      // glify's lines take [lat, lng] coordinates by default.
      features[e] = {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [g.lat[a], g.lon[a]],
            [g.lat[b], g.lon[b]],
          ],
        },
      }
    }
    const data = new Array(g.nodeCount)
    for (let i = 0; i < g.nodeCount; i++) data[i] = [g.lat[i], g.lon[i]]
    lines = glify.lines({
      map,
      data: { type: 'FeatureCollection', features },
      color: rgb(EDGE_COLOR_RGB),
      opacity: 1,
      // glify paints a line as a "brush" of offset copies, (4·weight + 1)² draws per frame;
      // 0.5 (9 draws) is the closest to a 1 px line.
      weight: 0.5,
      click: () => {
        clicked = true
      },
    })
    points = glify.points({
      map,
      data,
      size: NODE_RADIUS * 2, // a diameter, in pixels
      color: (i: number) => (highlighted[i] ? HIGHLIGHT : BASE),
      opacity: 1,
      click: () => {
        clicked = true
      },
    })
    // Both layers redraw on an animation frame requested before this one.
    await nextFrame()
  },
  setCamera(c) {
    map.setView([c.lat, c.lon], c.zoom, { animate: false })
  },
  async restyle(nodes, on) {
    for (let j = 0; j < nodes.length; j++) highlighted[nodes[j]] = on ? 1 : 0
    // glify re-reads colours by rebuilding the point vertices.
    points.render()
    await nextFrame()
  },
  pick(x, y) {
    // glify hit-tests on Leaflet's map click: fire one with the event fields it reads.
    clicked = false
    const containerPoint = L.point(x, y)
    const layerPoint = map.containerPointToLayerPoint(containerPoint)
    const latlng = map.layerPointToLatLng(layerPoint)
    map.fire('click', { latlng, layerPoint, containerPoint, originalEvent: new MouseEvent('click') })
    return clicked
  },
  surfaces() {
    return [
      { canvas: lines.canvas as HTMLCanvasElement, kind: 'webgl' },
      { canvas: points.canvas as HTMLCanvasElement, kind: 'webgl' },
    ]
  },
})
