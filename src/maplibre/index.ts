import type * as MapLibre from 'maplibre-gl'
import type { AdapterEvents, LayerElements, MapAdapter, Viewport } from '../adapter'
import { createGraphLayer, type GraphLayer, type GraphLayerOptions } from '../layer'
import { MERCATOR, mercatorUnit } from '../projection'
import { sceneBounds, type Scene } from '../scene'

/**
 * MapLibre GL adapter. The canvases sit above the map's own canvas in its canvas
 * container and are repainted on every map `render` event, so they stay in step during
 * animated pans, zooms and rotations.
 *
 * Supported: any zoom (fractional), bearing (rotation), map padding. Not supported:
 * pitch (a tilted, perspective view) — the overlay is drawn flat, so keep `maxPitch: 0`
 * on maps that use it; the adapter warns once if it sees a pitch. Set the layer's
 * `worldCopies` option to repeat the scene left and right of the main world, as MapLibre
 * repeats its tiles.
 *
 * `maplibre-gl` is not imported here (types only), so this entry adds nothing to your
 * bundle beyond the adapter itself.
 *
 * @module
 */

const scratchX = new Float64Array(1)
const scratchY = new Float64Array(1)

/** A {@link MapAdapter} for a MapLibre GL map. Scene coordinates are longitude/latitude. */
export function maplibreAdapter(map: MapLibre.Map): MapAdapter {
  let warnedPitch = false
  return {
    projection: MERCATOR,
    cursorTarget: map.getCanvas(),
    getViewport(): Viewport {
      const canvas = map.getCanvas()
      const width = canvas.clientWidth || map.getContainer().clientWidth
      const height = canvas.clientHeight || map.getContainer().clientHeight
      const zoom = map.getZoom()
      if (!warnedPitch && map.getPitch() > 0) {
        warnedPitch = true
        console.warn('skeinmap: the MapLibre adapter draws flat; set maxPitch: 0 on this map')
      }
      // The container centre, unprojected: honours map padding, which shifts it.
      const c = map.unproject([width / 2, height / 2])
      mercatorUnit(c.lng, c.lat, scratchX, scratchY, 0)
      return {
        width,
        height,
        // MapLibre's world is 512 px at zoom 0; a unit is a pixel of a 256 px world.
        k: Math.pow(2, zoom + 1),
        centerX: scratchX[0],
        centerY: scratchY[0],
        rotation: (-map.getBearing() * Math.PI) / 180,
        zoom,
      }
    },
    attach(elements: LayerElements, events: AdapterEvents) {
      const host = map.getCanvasContainer()
      host.appendChild(elements.base)
      host.appendChild(elements.overlay)
      const container = map.getContainer()
      container.appendChild(elements.tooltip)

      const onView = () => events.view()
      const onMove = (e: MapLibre.MapMouseEvent) => events.pointerMove(e.point.x, e.point.y)
      const onOut = () => events.pointerLeave()
      const onClick = (e: MapLibre.MapMouseEvent) => {
        if (events.click(e.point.x, e.point.y)) e.preventDefault()
      }
      map.on('render', onView)
      map.on('resize', onView)
      map.on('mousemove', onMove)
      map.on('mouseout', onOut)
      map.on('click', onClick)
      return () => {
        map.off('render', onView)
        map.off('resize', onView)
        map.off('mousemove', onMove)
        map.off('mouseout', onOut)
        map.off('click', onClick)
      }
    },
  }
}

/** Shorthand for `createGraphLayer(maplibreAdapter(map), options)`. */
export function addGraphLayer(map: MapLibre.Map, options: GraphLayerOptions): GraphLayer {
  return createGraphLayer(maplibreAdapter(map), options)
}

export interface FitOptions {
  /** Pixels kept free around the content. Default 40. */
  padding?: number
  /** Cap the zoom; a single point is shown at this zoom (default 8). */
  maxZoom?: number
  /** Animation duration in ms (0 jumps). Default 0. */
  duration?: number
}

/** Fit the map to a scene's nodes and paths. Returns false for an empty scene. */
export function fitScene(map: MapLibre.Map, scene: Scene, options: FitOptions = {}): boolean {
  const b = sceneBounds(scene)
  if (!b) return false
  const [x0, y0, x1, y1] = b
  const { padding = 40, maxZoom, duration = 0 } = options
  if (x0 === x1 && y0 === y1) {
    map.jumpTo({ center: [x0, y0], zoom: maxZoom ?? 8 })
    return true
  }
  map.fitBounds(
    [
      [x0, y0],
      [x1, y1],
    ],
    { padding, duration, ...(maxZoom !== undefined ? { maxZoom } : {}) },
  )
  return true
}
