---
title: Demo
aside: false
---

<script setup>
import { withBase } from 'vitepress'
const src = withBase('/demo/index.html')
</script>

# Demo

A synthetic graph — nodes clustered around made-up cities, local links to near neighbours, a
long-range backbone between hubs, some links drawn along wiggly polylines — at 10k, 100k or
1M elements. Switch the adapter (standalone, Leaflet, MapLibre), the renderer (WebGL2 or
Canvas 2D) and the kernels (WebAssembly or TypeScript), and watch the stats: backend,
instances drawn, level of detail in use, frame time. Hover for a tooltip; click a node to
select it, which rewrites a few style bytes and calls `restyle()`. Shift-drag selects a box
(`queryBox`). The display toggles exercise a node filter (`setFilter`), per-node colours by
degree (`nodeColor`), arrowheads on the backbone, clusters recomputed per zoom
(`createClusterIndex`) and world copies on the maps; "Import GeoJSON" round-trips a small
graph through `sceneToGeoJSON` / `sceneFromGeoJSON` with curved and great-circle links.

<p><a :href="src" target="_blank" rel="noopener">Open the demo full screen</a></p>

<iframe :src="src" title="skeinmap demo" class="demo-frame" loading="lazy"></iframe>

The data is produced in the browser by a seeded generator, so every load shows the same
graph. The source is in `examples/demo/` in the repository; run it locally with
`npm run dev:demo`.

<style>
.demo-frame {
  width: 100%;
  height: 78vh;
  min-height: 520px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
}
</style>
