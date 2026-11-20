import * as maplibregl from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { EDGE_COLOR, EDGE_WIDTH, HIGHLIGHT_COLOR, NODE_COLOR, NODE_RADIUS, run, type Camera } from '../../src/harness'

// MapLibre 6 looks for its worker next to its module at run time; hand it the emitted file.
maplibregl.setWorkerUrl(workerUrl)

let map: maplibregl.Map
// MapLibre uses 512 px tiles: its zoom is the 256 px zoom minus one.
const camera = (c: Camera) => ({ center: [c.lon, c.lat] as [number, number], zoom: c.zoom - 1 })
const idle = () =>
  new Promise<void>((r) => {
    map.once('idle', () => r())
    map.triggerRepaint()
  })

run({
  name: 'MapLibre GL JS',
  version: __VERSIONS__['maplibre-gl'],
  async setup(host, cam) {
    map = new maplibregl.Map({
      container: host,
      // An empty style: a background layer and nothing else (no tiles, no glyphs).
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#ffffff' } }],
      },
      ...camera(cam),
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      maxPitch: 0,
      pixelRatio: 1,
      renderWorldCopies: false,
    })
    await new Promise<void>((r) => map.once('load', () => r()))
  },
  async load(g) {
    const nodes: GeoJSON.Feature<GeoJSON.Point>[] = new Array(g.nodeCount)
    for (let i = 0; i < g.nodeCount; i++) {
      nodes[i] = {
        type: 'Feature',
        id: i,
        properties: {},
        geometry: { type: 'Point', coordinates: [g.lon[i], g.lat[i]] },
      }
    }
    const edges: GeoJSON.Feature<GeoJSON.LineString>[] = new Array(g.edgeCount)
    for (let e = 0; e < g.edgeCount; e++) {
      const a = g.from[e]
      const b = g.to[e]
      edges[e] = {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [g.lon[a], g.lat[a]],
            [g.lon[b], g.lat[b]],
          ],
        },
      }
    }
    map.addSource('edges', { type: 'geojson', data: { type: 'FeatureCollection', features: edges } })
    map.addSource('nodes', { type: 'geojson', data: { type: 'FeatureCollection', features: nodes } })
    map.addLayer({
      id: 'edges',
      type: 'line',
      source: 'edges',
      paint: { 'line-color': EDGE_COLOR, 'line-width': EDGE_WIDTH },
    })
    map.addLayer({
      id: 'nodes',
      type: 'circle',
      source: 'nodes',
      paint: {
        'circle-radius': NODE_RADIUS,
        // Restyle through feature state: no re-tiling.
        'circle-color': ['case', ['boolean', ['feature-state', 'hl'], false], HIGHLIGHT_COLOR, NODE_COLOR],
        'circle-stroke-width': 0,
      },
    })
    await idle()
  },
  setCamera(c) {
    map.jumpTo(camera(c))
  },
  async restyle(nodes, on) {
    for (let j = 0; j < nodes.length; j++) map.setFeatureState({ source: 'nodes', id: nodes[j] }, { hl: on })
    await idle()
  },
  pick(x, y) {
    return map.queryRenderedFeatures([x, y], { layers: ['nodes', 'edges'] }).length > 0
  },
  surfaces() {
    return [{ canvas: map.getCanvas(), kind: 'webgl' }]
  },
  idle,
  info() {
    return { zoom: map.getZoom() }
  },
})
