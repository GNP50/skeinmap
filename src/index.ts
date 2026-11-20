/**
 * skeinmap — draw and interact with very large node–link graphs on one canvas.
 *
 * The core is framework- and map-agnostic: build a {@link Scene} (flat typed arrays),
 * give it a style table, and hand both to {@link createGraphLayer} with an adapter —
 * `skeinmap/leaflet`, `skeinmap/maplibre`, the built-in {@link createPanZoomAdapter},
 * or your own {@link MapAdapter}.
 *
 * @packageDocumentation
 */
export { createGraphLayer, pointInPolygon, zoomScale } from './layer'
export type {
  GraphLayer,
  GraphLayerOptions,
  LayerFilter,
  LayerStats,
  LodOptions,
  OverlayColors,
  PickResult,
} from './layer'
export { HIDDEN, SceneBuilder, emptyScene, isRouted, rgba, sceneBounds, validateScene } from './scene'
export type { Bounds, Scene, SceneBuilderOptions } from './scene'
export { FALLBACK_EDGE_STYLE, FALLBACK_NODE_STYLE, MAX_STYLES, packColor, parseCssColor } from './styles'
export type { EdgeStyle, NodeStyle, Rgba, SceneStyles } from './styles'
export { IDENTITY, MAX_MERCATOR_LAT, MERCATOR, MERCATOR_WORLD, mercatorInverse, mercatorUnit } from './projection'
export type { Projection } from './projection'
export type { AdapterEvents, LayerElements, MapAdapter, Viewport } from './adapter'
export { createPanZoomAdapter } from './adapters/panzoom'
export type { PanZoomAdapter, PanZoomOptions } from './adapters/panzoom'
export { placeLabels } from './labels'
export type { LabelCandidate, LabelPlacementOptions } from './labels'
export { SceneGrid } from './grid'
export {
  getKernelPreference,
  initWasm,
  kernels,
  onKernelsChange,
  setKernelPreference,
  tsKernels,
  wasmError,
  wasmStatus,
} from './kernels/index'
export type { InitWasmOptions, KernelPreference, WasmSource, WasmStatus } from './kernels/index'
export { DEFAULT_CLUSTER_CELL_PX, lodFits, MAX_EDGE_CELLS, NO_CLUSTER } from './kernels/types'
export type {
  ClusterLevel,
  Clusterer,
  GridBuilder,
  GridData,
  GridPositions,
  GridTopology,
  GridWindow,
  Kernels,
  LodComputer,
  LodGeometry,
  LodLevel,
  Simplifier,
} from './kernels/types'
export { cssVar, escapeHtml, memoByTheme, observeTheme, tooltipCard } from './util'
export type { ObserveThemeOptions } from './util'
export { curvedPath, greatCirclePath, parallelCurvature } from './paths'
export { sceneFromGeoJSON, sceneFromGraph, sceneToGeoJSON } from './interop'
export type {
  GeoJSONFeatureCollectionLike,
  GeoJSONFeatureLike,
  GeoJSONGeometryLike,
  GeoJSONPosition,
  GraphLike,
  SceneEdgeFeature,
  SceneFeatureCollection,
  SceneFromGeoJSONOptions,
  SceneFromGeoJSONResult,
  SceneFromGraphOptions,
  SceneFromGraphResult,
  SceneNodeFeature,
} from './interop'
export { createClusterIndex } from './cluster'
export type { ClusterIndex, ClusterIndexOptions, ClusterView } from './cluster'
