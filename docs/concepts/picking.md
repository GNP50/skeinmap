# Picking, hover and tooltips

The layer answers "what is under the pointer" without looking at every element, shows a
tooltip, outlines the element under the pointer and reports clicks. All of it is
configured through layer options.

```ts
import { createGraphLayer, tooltipCard } from 'skeinmap'

const layer = createGraphLayer(adapter, {
  scene,
  styles,
  hitRadius: 8,
  onNodeClick: (i) => openDetails(items[i]),
  onEdgeClick: (e) => console.log('edge', e),
  onHover: (hit) => setStatus(hit ? `${hit.kind} ${hit.index}` : ''),
  tooltipHtml: true,
  nodeTooltip: (i) => tooltipCard(items[i].name, [['visits', String(items[i].visits)]], items[i].kind),
  edgeTooltip: (e) => `Link ${e}`,
})
```

## How a pick works

Positions are kept in _absolute pixels_: units multiplied by the view's scale and
rotation, but not shifted by the pan. A pan only changes the offset everything is drawn and
tested at, so absolute pixels stay valid through a drag and are recomputed only when the
zoom (or rotation, or the scene) changes.

Picking builds a uniform grid of 32 px cells over a _window_ in those coordinates: the
viewport plus half a screen on each side. Each cell lists the nodes inside it and the edges
whose bounding box touches it (a routed edge uses the box of its polyline). A query looks at
the few cells around the pointer. Edges that would cover more than 64 cells — long lines
across the view — are kept in a separate short list that every query checks.

The grid is rebuilt when the zoom or the scene changes, or when the pointer leaves the
window. Building it is one of the [kernels](./wasm.md), so it runs in WebAssembly once that
is loaded. Nothing is built until the pointer first moves over the layer, and nothing at all
when there are no tooltips, click handlers or `onHover`.

Rules:

- A node is hit within `max(hitRadius, radius × scale + 3)` pixels of its centre; the
  closest one wins. `hitRadius` defaults to 8.
- An edge is hit within `hitRadius` pixels of its line or polyline; the closest segment
  wins.
- **Nodes win over edges.** Edges are only tested when no node is hit, so a node at the end
  of an edge is always reachable.
- Hover is coalesced to one pick per animation frame however fast the pointer moves.

`layer.pick(x, y)` runs the same query for container pixel `(x, y)` and returns
`{ kind: 'node' | 'edge', index } | null` — useful for a context menu or a custom gesture.

## Clicks

`onNodeClick(index)` and `onEdgeClick(index)` receive the scene index. When a click picks
something, the adapter stops it from reaching the host: no map click (and no popup or
deselection logic of yours) fires under a picked node. A click that picks nothing passes
through.

Only wire the handlers you need. A layer with `onNodeClick` but no `onEdgeClick` lets clicks
on edges through to the map.

## Hover

With `hoverHighlight` (the default) the element under the pointer is outlined in the
overlay's accent colour (`overlayColors.accent`, default `#2563eb`), and the cursor becomes
a pointer over anything a click would pick. Repainting the outline only touches the 2D
overlay canvas, never the scene.

`onHover(hit)` fires when the element under the pointer changes, with `null` when it leaves
everything. Use it to sync another view (a table row, a details panel) with the graph.

## Tooltips

`nodeTooltip(index)` and `edgeTooltip(index)` return the tooltip's content, or `null` for
none. The tooltip is a `<div>` positioned next to the pointer and flipped to the other side
near the edges of the view. Its class is `skeinmap-tooltip` (change it with
`tooltipClassName`); `skeinmap/style.css` gives it a default look.

By default the string is set as **text** (`textContent`): whatever it contains is shown
literally and cannot inject markup.

With `tooltipHtml: true` the string is set as **HTML** (`innerHTML`). You must then escape
every value that comes from data:

```ts
import { escapeHtml } from 'skeinmap'

nodeTooltip: (i) => `<strong>${escapeHtml(items[i].name)}</strong><br>${escapeHtml(items[i].note)}`
```

`tooltipCard(title, rows?, subtitle?)` builds the common case — a title, an optional
subtitle and label/value rows — and escapes every part for you:

```ts
nodeTooltip: (i) =>
  tooltipCard(
    items[i].name,
    [
      ['category', items[i].category],
      ['degree', String(degree[i])],
    ],
    'node',
  )
```

It produces `.skeinmap-card-title`, `.skeinmap-card-sub` and `.skeinmap-card-row`
elements, styled by `skeinmap/style.css`. See also
[Content Security Policy](../guide/csp.md#tooltips-and-cross-site-scripting).

Tooltip functions run on every hover change, so keep them cheap: look up precomputed values
rather than scanning the scene.
