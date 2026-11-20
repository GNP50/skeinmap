/**
 * Projections from scene coordinates to *units*: the layer's internal plane, where a
 * zoom is a single multiply. For the Mercator projection a unit is a pixel of a 256 px
 * world at zoom 0 (the convention Leaflet uses), so the pixel position at zoom `z` is the
 * unit position times `2^z`.
 *
 * @module
 */

/** Latitude where spherical Mercator is clamped (the square world of web maps). */
export const MAX_MERCATOR_LAT = 85.0511287798

/** World size in units at zoom 0 for {@link mercatorUnit}. */
export const MERCATOR_WORLD = 256

/**
 * How scene coordinates become units.
 * - `mercator`: x = longitude, y = latitude in degrees → spherical Mercator (EPSG:3857).
 * - `identity`: x/y are already units (the standalone view).
 * - `custom`: anything else (another CRS); `project` writes units for one point.
 */
export type Projection =
  | { kind: 'mercator' }
  | { kind: 'identity' }
  | { kind: 'custom'; project: (x: number, y: number, out: { x: number; y: number }) => void }

/** The spherical Mercator projection. */
export const MERCATOR: Projection = { kind: 'mercator' }
/** No projection: scene coordinates are units. */
export const IDENTITY: Projection = { kind: 'identity' }

/**
 * Spherical Mercator at zoom 0, written out: identical to Leaflet's
 * `map.project([lat, lon], 0)` on the default CRS, without per-point allocations.
 * Writes into `outX[i]` / `outY[i]`.
 */
export function mercatorUnit(lon: number, lat: number, outX: Float64Array, outY: Float64Array, i: number): void {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat))
  const sin = Math.sin((clamped * Math.PI) / 180)
  outX[i] = MERCATOR_WORLD * (0.5 + lon / 360)
  outY[i] = MERCATOR_WORLD * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI))
}

/** Inverse of {@link mercatorUnit}: units back to `[lon, lat]`. */
export function mercatorInverse(ux: number, uy: number): [number, number] {
  const lon = (ux / MERCATOR_WORLD - 0.5) * 360
  const n = Math.PI - (2 * Math.PI * uy) / MERCATOR_WORLD
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n))
  return [lon, lat]
}
