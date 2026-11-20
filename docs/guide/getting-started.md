# Getting started

skeinmap draws a node–link graph — discs joined by lines or polylines — on a single
canvas above a map or inside any positioned element. You describe the graph as flat typed
arrays (a [scene](../concepts/scene.md)), give it a small table of
[styles](../concepts/styles.md), and hand both to `createGraphLayer` together with an
[adapter](../concepts/adapters.md) that says where the view is.

## Install

```sh
npm install github:GNP50/skeinmap#<commit-or-tag>   # builds on install: needs Rust + wasm-bindgen, see the README
```

The map libraries and React are optional peer dependencies. Install the ones you use:

```sh
npm install leaflet          # for skeinmap/leaflet
npm install maplibre-gl      # for skeinmap/maplibre
npm install react            # for skeinmap/react
```

| Import                | What it contains                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `skeinmap`            | The layer, scenes, styles, the pan/zoom adapter, kernels, helpers                                               |
| `skeinmap/leaflet`    | `leafletAdapter`, `addGraphLayer`, `createLeafletLayer`, `fitScene`                                             |
| `skeinmap/maplibre`   | `maplibreAdapter`, `addGraphLayer`, `fitScene`                                                                  |
| `skeinmap/react`      | `useGraphLayer`, `<GraphCanvas>`                                                                                |
| `skeinmap/lod-worker` | Level-of-detail worker entry (optional, see [Rendering](../concepts/rendering.md#computing-levels-in-a-worker)) |
| `skeinmap/style.css`  | Default look of the hover tooltip and card                                                                      |
| `skeinmap/wasm`       | The `.wasm` binary, if you need its URL or bytes yourself                                                       |

Both ES modules and CommonJS builds are published, with type declarations for each.

## A first scene

Every quickstart below uses a scene and a style table like these:

```ts
import { SceneBuilder, type SceneStyles } from 'skeinmap'

const b = new SceneBuilder()
// x = longitude, y = latitude on a map; plain world units on the standalone view.
const a = b.node(2.35, 48.86, 0)
const c = b.node(13.4, 52.52, 1)
const d = b.node(12.5, 41.9, 0)
b.edge(a, c, 0)
b.edge(c, d, 0, [13.4, 52.52, 15.0, 47.0, 12.5, 41.9]) // drawn along a polyline
const scene = b.build()

const styles: SceneStyles = {
  nodes: [
    { radius: 4, fill: '#0e7490' }, // style 0
    { radius: 7, fill: '#c2410c', stroke: '#fff', strokeWidth: 1.5 }, // style 1
  ],
  edges: [{ color: '#64748b', width: 1.5 }],
}
```

The third argument of `node` and `edge` is a style byte: an index into `styles.nodes` or
`styles.edges`. Keep your own data (names, attributes) in your own arrays, indexed the
same way as the scene.

## Standalone (no map)

The built-in pan/zoom adapter turns any element with a size into a view: drag to pan,
wheel or pinch to zoom. It has no dependencies.

```ts
import { createGraphLayer, createPanZoomAdapter, initWasm, sceneBounds, MERCATOR, mercatorUnit } from 'skeinmap'
import 'skeinmap/style.css'

void initWasm() // optional; the layer starts on TypeScript and switches when this resolves

const element = document.getElementById('graph')! // must have a width and height
const adapter = createPanZoomAdapter(element) // identity projection: x/y are world units, y down
const layer = createGraphLayer(adapter, {
  scene,
  styles,
  nodeTooltip: (i) => `Node ${i}`,
  onNodeClick: (i) => console.log('clicked node', i),
})
adapter.fitBounds(sceneBounds(scene)!)
```

For geographic coordinates without a basemap, pass `projection: MERCATOR`. The view is
then in Mercator units (see [Projections](../concepts/scene.md#coordinates-and-units)),
so fit it to projected bounds:

```ts
const adapter = createPanZoomAdapter(element, { projection: MERCATOR })
const [x0, y0, x1, y1] = sceneBounds(scene)!
const ux = new Float64Array(2)
const uy = new Float64Array(2)
mercatorUnit(x0, y1, ux, uy, 0) // north-west corner
mercatorUnit(x1, y0, ux, uy, 1) // south-east corner
adapter.fitBounds([ux[0], uy[0], ux[1], uy[1]])
```

## Leaflet

Leaflet is passed in rather than imported, so the adapter works with any Leaflet 1.9
build and is safe to import during server-side rendering.

```ts
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'skeinmap/style.css'
import { addGraphLayer, fitScene } from 'skeinmap/leaflet'

const map = L.map('map')
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map)

const layer = addGraphLayer(L, map, { scene, styles, nodeTooltip: (i) => `Node ${i}` })
fitScene(L, map, scene)
```

To put the graph in a layer control, use `createLeafletLayer`, which returns a real
`L.Layer`: the graph layer is created when it is added to the map and destroyed when it is
removed.

```ts
import { createLeafletLayer } from 'skeinmap/leaflet'

const graphLayer = createLeafletLayer(L, { scene, styles })
L.control.layers({}, { Graph: graphLayer }).addTo(map)
graphLayer.addTo(map)
graphLayer.graph?.restyle() // the GraphLayer while it is on the map, else null
```

## MapLibre GL

```ts
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import 'skeinmap/style.css'
import { addGraphLayer, fitScene } from 'skeinmap/maplibre'

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  maxPitch: 0, // the graph is drawn flat; see the note below
})

const layer = addGraphLayer(map, { scene, styles })
fitScene(map, scene)
```

The MapLibre adapter supports fractional zoom, bearing (rotation) and map padding. It does
not support pitch: keep `maxPitch: 0`. It logs one warning if it sees a pitched map.

## React

`skeinmap/react` has a component for the standalone view and a hook for any adapter.
Callbacks are read through a ref, so inline arrow functions do not rebuild anything; a new
`scene` object re-projects, and other options are applied with `setOptions` when they
change.

```tsx
import { useRef } from 'react'
import { GraphCanvas, type GraphCanvasHandle } from 'skeinmap/react'
import 'skeinmap/style.css'

export function Graph({ scene, names }: { scene: Scene; names: string[] }) {
  const ref = useRef<GraphCanvasHandle>(null)
  return (
    <GraphCanvas
      ref={ref}
      scene={scene}
      styles={styles}
      style={{ height: 600 }}
      nodeTooltip={(i) => names[i]}
      onNodeClick={(i) => console.log(names[i])}
    />
  )
}
```

`ref.current.fit()` refits the view, `ref.current.layer` is the `GraphLayer`.

With a map, create the map in an effect and pass its adapter to `useGraphLayer`:

```tsx
import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import type { MapAdapter, Scene } from 'skeinmap'
import { leafletAdapter } from 'skeinmap/leaflet'
import { useGraphLayer } from 'skeinmap/react'

export function MapGraph({ scene }: { scene: Scene }) {
  const host = useRef<HTMLDivElement>(null)
  const [adapter, setAdapter] = useState<MapAdapter | null>(null)

  useEffect(() => {
    const map = L.map(host.current!).setView([48, 10], 5)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map)
    setAdapter(leafletAdapter(L, map))
    return () => {
      setAdapter(null)
      map.remove()
    }
  }, [])

  const layer = useGraphLayer(adapter, scene, { styles, nodeTooltip: (i) => `Node ${i}` })
  // layer.current?.restyle() after writing style bytes in place
  return <div ref={host} style={{ height: 600 }} />
}
```

The layer is created once both the adapter and the scene are non-null and destroyed when
either goes back to `null` or the component unmounts.

## Vue

There is no Vue wrapper; the core is small enough to use directly. Create the layer in
`onMounted` and destroy it in `onBeforeUnmount`. Keep the scene out of deep reactivity
(`shallowRef` or `markRaw`): the layer compares scene objects by identity.

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  createGraphLayer,
  createPanZoomAdapter,
  sceneBounds,
  type GraphLayer,
  type PanZoomAdapter,
  type Scene,
} from 'skeinmap'
import 'skeinmap/style.css'

const props = defineProps<{ scene: Scene }>()
const host = ref<HTMLDivElement>()
let adapter: PanZoomAdapter | undefined
let layer: GraphLayer | undefined

onMounted(() => {
  adapter = createPanZoomAdapter(host.value!)
  layer = createGraphLayer(adapter, { scene: props.scene, styles })
  adapter.fitBounds(sceneBounds(props.scene)!)
})
watch(
  () => props.scene,
  (scene) => layer?.setScene(scene),
)
onBeforeUnmount(() => {
  layer?.destroy()
  adapter?.dispose()
})
</script>

<template>
  <div ref="host" style="height: 600px" />
</template>
```

## Svelte

The same pattern with `onMount` and `onDestroy` (Svelte 5 shown). If the parent keeps the
scene in state, use `$state.raw` so it is not wrapped in a deep proxy.

```svelte
<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { createGraphLayer, createPanZoomAdapter, sceneBounds, type GraphLayer, type PanZoomAdapter, type Scene } from 'skeinmap'
  import 'skeinmap/style.css'

  let { scene }: { scene: Scene } = $props()
  let host: HTMLDivElement
  let adapter: PanZoomAdapter | undefined
  let layer: GraphLayer | undefined

  onMount(() => {
    adapter = createPanZoomAdapter(host)
    layer = createGraphLayer(adapter, { scene, styles })
    adapter.fitBounds(sceneBounds(scene)!)
  })
  $effect(() => {
    if (layer && layer.scene !== scene) layer.setScene(scene)
  })
  onDestroy(() => {
    layer?.destroy()
    adapter?.dispose()
  })
</script>

<div bind:this={host} style="height: 600px"></div>
```

## Next steps

- [Bundlers and frameworks](./frameworks.md): Vite, webpack, Next.js, server-side rendering.
- [Scenes](../concepts/scene.md) and [styles](../concepts/styles.md): the data model.
- [Picking](../concepts/picking.md): clicks, hover and tooltips.
- The [demo](../demo.md) runs all three adapters on up to a million synthetic elements.
