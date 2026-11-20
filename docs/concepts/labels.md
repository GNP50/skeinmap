# Labels

The layer can name nodes: text centred above the disc, with a halo so it reads over any
background. Labels are placed greedily on an occupancy grid, so a sparse view names every
node and a dense one only what fits without overlapping.

```ts
createGraphLayer(adapter, {
  scene,
  styles,
  nodeLabel: (i) => names[i], // null for no label
  labelPriority: (i) => (isHub[i] ? 2 : 1),
  labelFont: '12px Inter, system-ui, sans-serif',
  overlayColors: { text: '#111', halo: 'rgba(255,255,255,0.92)' },
})

layer.setOptions({ labels: false }) // toggle without rebuilding anything
```

## Priority

`labelPriority(index)` (default 1 for every node) decides who wins a collision and who is
considered at all:

| Priority | Behaviour                                                                               |
| -------- | --------------------------------------------------------------------------------------- |
| `≥ 2`    | Drawn **bold**. Stays a candidate in dense views (see the limits below)                 |
| `1`      | Normal                                                                                  |
| `≤ 0`    | Only named when the view is sparse: when the nodes in view are no more than `maxLabels` |

Higher priorities are placed first; ties keep scene order. A label whose box overlaps one
already placed is dropped for this frame.

A typical scheme: `0` for filler nodes you never want to crowd the view, `1` for ordinary
nodes, `2` for hubs or anything highlighted, `3` for the current selection so it always
wins.

## Placement

For every node inside the viewport the layer asks for its text (`nodeLabel`), measures it
(widths are cached per string and weight), and hands the candidates to `placeLabels`:

- The view is divided into 8 px cells.
- Candidates are visited in priority order. Each claims the cells its box covers — the text
  width plus 3 px each side, 14 px high above the baseline — if they are all free;
  otherwise it is skipped.
- Placement stops after `maxLabels` labels.

`placeLabels(candidates, options)` is exported and pure (no canvas, no DOM), so the same
decluttering can drive labels you draw yourself, for example HTML markers.

## Limits

| Option               | Default             | Meaning                                                              |
| -------------------- | ------------------- | -------------------------------------------------------------------- |
| `maxLabels`          | 220                 | Labels per frame at most                                             |
| `maxLabelCandidates` | 3000                | Past this many nodes in view, only priority ≥ 2 nodes are candidates |
| `labels`             | `true`              | Draw labels at all                                                   |
| `labelFont`          | `11px system-ui, …` | CSS font; the weight (500 or 700) is prepended                       |

Labels are drawn on the 2D overlay canvas and recomputed on every paint of the overlay,
which includes every pan and zoom step. Finding the nodes in view is a pass over all node
positions, so with hundreds of thousands of nodes labels become a noticeable part of each frame,
independent of the drawing backend. If that matters, return `null` from `nodeLabel` for nodes that will
never be named, give most nodes priority `0`, or turn labels off while the user is
navigating.

Only nodes have labels. Edges can be described in tooltips (see
[Picking](./picking.md#tooltips)).
