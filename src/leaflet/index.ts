import type * as Leaflet from 'leaflet'
import type { AdapterEvents, LayerElements, MapAdapter, Viewport } from '../adapter'
import { createGraphLayer, type GraphLayer, type GraphLayerOptions } from '../layer'
import { MERCATOR, type Projection } from '../projection'
import { sceneBounds, type Scene } from '../scene'

/**
 * Leaflet adapter. Leaflet is passed in rather than imported, so this entry has no hard
 * dependency, works with any Leaflet 1.9 build (ESM, UMD global, a plugin-patched copy)
 * and is safe to import during server-side rendering.
 *
 * The canvases live in a map pane and move with it during a pan; a zoom animation scales
 * them with the tiles (Leaflet's `zoomanim`), and they are redrawn when it ends. The
 * default CRS (EPSG:3857) is projected by the WASM/TypeScript kernels; any other CRS goes
 * through `map.project` per point.
 *
 * @module
 */

type L = typeof Leaflet

export interface LeafletAdapterOptions {
  /** Pane the canvases go into. Default `overlayPane`. */
  pane?: string
}

/** A {@link MapAdapter} for a Leaflet map. Scene coordinates are longitude/latitude. */
export function leafletAdapter(L: L, map: Leaflet.Map, options: LeafletAdapterOptions = {}): MapAdapter {
  const crs = map.options.crs
  const isMercator = crs == null || crs === L.CRS.EPSG3857
  const projection: Projection = isMercator
    ? MERCATOR
    : {
        kind: 'custom',
        project(x, y, out) {
          const p = map.project([y, x], 0)
          out.x = p.x
          out.y = p.y
        },
      }

  return {
    projection,
    cursorTarget: map.getContainer(),
    getViewport(): Viewport {
      const size = map.getSize()
      const zoom = map.getZoom()
      const k = map.getZoomScale(zoom, 0)
      const origin = map.getPixelOrigin()
      const corner = map.containerPointToLayerPoint([0, 0])
      return {
        width: size.x,
        height: size.y,
        k,
        centerX: (origin.x + corner.x + size.x / 2) / k,
        centerY: (origin.y + corner.y + size.y / 2) / k,
        rotation: 0,
        zoom,
      }
    },
    beforePaint(elements: LayerElements) {
      // Anchor the canvases to the container's top-left in layer space, so a pan moves
      // them with the map. This also drops the scale a zoom animation left on them.
      const corner = map.containerPointToLayerPoint([0, 0])
      L.DomUtil.setPosition(elements.base, corner)
      L.DomUtil.setPosition(elements.overlay, corner)
    },
    attach(elements: LayerElements, events: AdapterEvents) {
      const pane = map.getPane(options.pane ?? 'overlayPane') ?? map.getPanes().overlayPane
      for (const c of [elements.base, elements.overlay]) {
        c.classList.add('leaflet-layer', 'leaflet-zoom-animated')
        pane.appendChild(c)
      }
      map.getContainer().appendChild(elements.tooltip)

      const onView = () => events.view()
      const onZoomAnim = (e: Leaflet.ZoomAnimEvent) => {
        const m = map as Leaflet.Map & {
          _latLngBoundsToNewLayerBounds?: (
            b: Leaflet.LatLngBounds,
            zoom: number,
            center: Leaflet.LatLng,
          ) => Leaflet.Bounds
        }
        const min = m._latLngBoundsToNewLayerBounds?.(map.getBounds(), e.zoom, e.center).min
        if (!min) return
        const scale = map.getZoomScale(e.zoom)
        L.DomUtil.setTransform(elements.base, min, scale)
        L.DomUtil.setTransform(elements.overlay, min, scale)
      }
      const onMove = (e: Leaflet.LeafletMouseEvent) => events.pointerMove(e.containerPoint.x, e.containerPoint.y)
      const onOut = () => events.pointerLeave()
      const onClick = (e: Leaflet.LeafletMouseEvent) => {
        if (events.click(e.containerPoint.x, e.containerPoint.y)) L.DomEvent.stopPropagation(e)
      }
      map.on('move zoom viewreset resize zoomend moveend', onView)
      map.on('zoomanim', onZoomAnim)
      map.on('mousemove', onMove)
      map.on('mouseout', onOut)
      map.on('click', onClick)
      return () => {
        map.off('move zoom viewreset resize zoomend moveend', onView)
        map.off('zoomanim', onZoomAnim)
        map.off('mousemove', onMove)
        map.off('mouseout', onOut)
        map.off('click', onClick)
      }
    },
  }
}

/** Shorthand for `createGraphLayer(leafletAdapter(L, map), options)`. */
export function addGraphLayer(
  L: L,
  map: Leaflet.Map,
  options: GraphLayerOptions,
  adapterOptions?: LeafletAdapterOptions,
): GraphLayer {
  return createGraphLayer(leafletAdapter(L, map, adapterOptions), options)
}

/** A Leaflet layer wrapping a graph layer, for `L.control.layers` and `map.removeLayer`. */
export interface LeafletGraphLayer extends Leaflet.Layer {
  /** The graph layer while the Leaflet layer is on a map, else null. */
  readonly graph: GraphLayer | null
  /** Options to apply on the next add (and now, if added). */
  setGraphOptions(options: Partial<GraphLayerOptions>): void
}

/**
 * A real `L.Layer`: the graph layer is created on `onAdd` and destroyed on `onRemove`,
 * so it can sit in a layer control. Options set while it is off the map are kept.
 */
export function createLeafletLayer(
  L: L,
  options: GraphLayerOptions,
  adapterOptions?: LeafletAdapterOptions,
): LeafletGraphLayer {
  const opts: GraphLayerOptions = { ...options }
  let graph: GraphLayer | null = null
  const Layer = L.Layer.extend({
    onAdd(this: Leaflet.Layer, map: Leaflet.Map) {
      graph = createGraphLayer(leafletAdapter(L, map, adapterOptions), opts)
      return this
    },
    onRemove() {
      if (graph) opts.scene = graph.scene
      graph?.destroy()
      graph = null
      return this
    },
  })
  const layer = new Layer() as LeafletGraphLayer
  Object.defineProperty(layer, 'graph', { get: () => graph })
  layer.setGraphOptions = (next) => {
    Object.assign(opts, next)
    if (!graph) return
    if (next.scene) graph.setScene(next.scene)
    graph.setOptions(next)
  }
  return layer
}

export interface FitOptions {
  /** Pixels kept free around the content. Default 40. */
  padding?: number
  /** Cap the zoom; a single point is shown at this zoom (default 8). */
  maxZoom?: number
  animate?: boolean
}

/**
 * Fit the map to a scene's nodes and paths. A single point is shown at `maxZoom` (or 8)
 * instead of zooming all the way in. Returns false for an empty scene.
 */
export function fitScene(L: L, map: Leaflet.Map, scene: Scene, options: FitOptions = {}): boolean {
  const b = sceneBounds(scene)
  if (!b) return false
  const [x0, y0, x1, y1] = b
  const { padding = 40, maxZoom, animate } = options
  if (x0 === x1 && y0 === y1) {
    map.setView([y0, x0], maxZoom ?? 8, animate === undefined ? undefined : { animate })
    return true
  }
  map.fitBounds(L.latLngBounds([y0, x0], [y1, x1]), {
    padding: [padding, padding],
    ...(maxZoom !== undefined ? { maxZoom } : {}),
    ...(animate !== undefined ? { animate } : {}),
  })
  return true
}
