---
layout: home

hero:
  name: skeinmap
  text: Large node–link graphs on one canvas
  tagline: Hundreds of thousands of nodes and edges on a map or a plain pan/zoom view, with picking, hover, tooltips and labels. WebGL2 or Canvas 2D, WebAssembly where it pays, TypeScript everywhere else.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Open the demo
      link: /demo
    - theme: alt
      text: API reference
      link: /api/

features:
  - title: One canvas, not one object per element
    details: A scene is a handful of typed arrays. Nodes are discs and edges are lines or polylines, all drawn by one layer, so a million elements cost memory proportional to a million numbers, not a million DOM or map objects.
  - title: WebGL2 with a Canvas 2D fallback
    details: On WebGL2 the scene lives on the GPU and a pan or zoom only updates a few uniforms. Without it, or after a lost context, the layer draws with Canvas 2D and simplifies polylines per zoom.
  - title: Restyle is a byte write
    details: Every element carries a style byte that indexes a table of up to 32 styles. Highlighting a selection or switching theme rewrites bytes and colours, never geometry.
  - title: Picking that does not scan the scene
    details: Hover and click go through a uniform grid in absolute pixels that survives panning. Tooltips, a hover outline and decluttered labels come with the layer.
  - title: WebAssembly is optional
    details: Projection, level-of-detail binning, grid builds and Douglas–Peucker run in Rust compiled to WebAssembly once it has loaded, and in TypeScript with identical output before that, or if it never does.
  - title: Filters, selection and clusters
    details: Hide elements with a byte mask instead of rebuilding, select nodes in a box or a lasso, and swap in grid clusters per zoom with member lists. Per-element colours, sizes and arrowheads where a style byte is not enough.
  - title: Leaflet, MapLibre, React, or nothing
    details: Small adapters for Leaflet 1.9 and MapLibre GL, a React hook and component, and a dependency-free pan/zoom view. The adapter contract is four members, so writing your own is short.
---
