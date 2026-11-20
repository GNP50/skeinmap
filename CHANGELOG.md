# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries from
0.1.1 onwards are written by [Changesets](https://github.com/changesets/changesets) from the
changesets merged with each release.

## 0.1.0

Initial release.

### Added

- Dual licensed under MIT or Apache-2.0, at your option.
- **Core layer** (`createGraphLayer`): draws very large node–link graphs on a single canvas
  from a flat, typed-array `Scene` (`SceneBuilder`, `validateScene`) and a small style table
  of node and edge styles. Click and hover callbacks with hover highlighting, tooltips,
  labels with collision avoidance, and picking through a uniform hit-test grid.
- **Renderers**: WebGL2 with high-precision coordinates, and a Canvas 2D fallback picked
  automatically when WebGL2 is unavailable.
- **Level of detail**: a cell-based level of detail per zoom that keeps the visible result
  indistinguishable from the full scene, with routed (polyline) edges simplified by
  Douglas–Peucker; optionally computed in a Web Worker (`skeinmap/lod-worker`).
- **WebAssembly kernels with a TypeScript fallback**: Mercator projection, level of detail,
  hit-test grid, polyline simplification and clustering in Rust compiled to WebAssembly
  (`initWasm()`, `kernels()`), with identical pure TypeScript implementations used until
  the module is loaded, if it fails to load, or on request (`setKernelPreference`).
- **Adapters**: Leaflet (`skeinmap/leaflet`), MapLibre GL (`skeinmap/maplibre`) and a
  standalone pan/zoom view (`createPanZoomAdapter`), plus the `MapAdapter` interface for
  custom hosts.
- **React bindings** (`skeinmap/react`).
- **Filters** (`layer.setFilter`): hide nodes and edges with byte masks, optionally with the
  edges of hidden nodes, without rebuilding the scene. The `HIDDEN` style byte (255) hides an
  element from drawing, picking, labels, queries, levels of detail and clustering; levels of
  detail are recomputed after a filter change.
- **Per-element attributes**: optional `nodeColor`, `nodeRadius`, `edgeColor` and `edgeWidth`
  arrays on a scene override the style table per element; `rgba()` and `packColor()` build
  packed `0xRRGGBBAA` colours.
- **Arrowheads**: `EdgeStyle.arrow` draws an arrowhead at an edge's `to` end, tip on the node's
  rim, following the last segment of a routed edge.
- **Selection queries**: `layer.queryBox` and `layer.queryPolygon` return the visible nodes
  inside a box or polygon in container pixels; `pointInPolygon` is exported.
- **Standalone view**: keyboard navigation (`keyboard`, `keyboardPanStep`, `onReset`) and
  shift-drag box selection (`onBoxSelect`, `selectionClassName`, styled by
  `.skeinmap-selection` in `skeinmap/style.css`).
- **World copies** (`worldCopies` option): the scene is drawn on every copy of the world in
  view on Mercator adapters, with picking, labels and queries on each.
- **Clustering** (`createClusterIndex`): grid clusters per zoom with counts, member lists and
  merged edges, on the WebAssembly (`clusterLevel`, `createClusterer`) or TypeScript kernels
  with identical results.
- **Interop**: `sceneFromGeoJSON`, `sceneToGeoJSON` and `sceneFromGraph` (graphology-style
  graphs), with structural input types and no added dependency.
- **Edge paths**: `curvedPath`, `parallelCurvature` and `greatCirclePath` produce curved,
  fanned-out parallel and great-circle edges for `SceneBuilder.edge`.
- Dual ESM and CommonJS builds with type declarations for both, and a stylesheet
  (`skeinmap/style.css`).
