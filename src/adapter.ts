import type { Projection } from './projection'

/**
 * The contract between the layer and whatever it is drawn on — a Leaflet map, a MapLibre
 * map, the standalone pan/zoom view, or your own. An adapter answers three questions:
 * where is the view ({@link Viewport}), where do the canvases go, and which pointer
 * events happened. Everything else (projection caching, drawing, picking, labels) is the
 * layer's job, so an adapter is typically under a hundred lines.
 *
 * @module
 */

/**
 * The view, in *units* (see {@link Projection}). A unit position `u` is drawn at the
 * container pixel `R(rotation) · k · (u − center) + (width, height) / 2`.
 */
export interface Viewport {
  /** Container size in CSS pixels. */
  width: number
  height: number
  /** Pixels per unit. For a Mercator map this is `2^zoom` in Leaflet's convention. */
  k: number
  /** Unit coordinates of the container's centre. */
  centerX: number
  centerY: number
  /** Screen rotation in radians, clockwise (screen y points down). Default 0. */
  rotation?: number
  /** Device pixel ratio for the backing store. Default `window.devicePixelRatio`. */
  dpr?: number
  /** The host's own zoom level, passed through to callbacks (informational). */
  zoom: number
}

/** What the layer hands an adapter to put into the page. */
export interface LayerElements {
  /** The network (WebGL2 or Canvas 2D). */
  base: HTMLCanvasElement
  /** Always Canvas 2D: labels and the hover outline, above `base`. */
  overlay: HTMLCanvasElement
  /** The hover tooltip; position it relative to the same box as the canvases. */
  tooltip: HTMLDivElement
}

/** Callbacks an adapter invokes. Coordinates are container pixels. */
export interface AdapterEvents {
  /** The view moved, zoomed, rotated or resized: repaint now, in step with the host. */
  view(): void
  pointerMove(x: number, y: number): void
  pointerLeave(): void
  /** Returns true when the click picked something, so the adapter can stop it from
   *  reaching the host (no map click under a picked node). */
  click(x: number, y: number): boolean
}

export interface MapAdapter {
  /** How scene coordinates become units. */
  readonly projection: Projection
  /** The current view. Called at least once per paint; keep it cheap. */
  getViewport(): Viewport
  /** Put the elements into the page and start delivering events. Returns the teardown. */
  attach(elements: LayerElements, events: AdapterEvents): () => void
  /** Called at the start of every paint, after the backing stores were sized: a chance
   *  to position the canvases (Leaflet re-anchors them in its panning layer). */
  beforePaint?(elements: LayerElements): void
  /** Where the "pointer" cursor is set over something pickable. */
  readonly cursorTarget: HTMLElement
}
