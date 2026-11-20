// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AdapterEvents, LayerElements, MapAdapter, Viewport } from '../src/adapter'
import { tsKernels } from '../src/kernels/index'
import { createGraphLayer, zoomScale, type GraphLayer } from '../src/layer'
import { IDENTITY, MERCATOR, type Projection } from '../src/projection'
import { SceneBuilder } from '../src/scene'
import type { SceneStyles } from '../src/styles'
import { contexts, flushFrames, installFakeCanvas, type Recording2d } from './helpers/fakeCanvas'

beforeAll(() => installFakeCanvas())

interface FakeAdapter extends MapAdapter {
  view: Viewport
  events: AdapterEvents | null
  host: HTMLDivElement
}

function fakeAdapter(view: Partial<Viewport> = {}, projection: Projection = IDENTITY): FakeAdapter {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const a: FakeAdapter = {
    projection,
    cursorTarget: host,
    host,
    events: null,
    view: { width: 800, height: 600, k: 1, centerX: 400, centerY: 300, rotation: 0, zoom: 0, dpr: 1, ...view },
    getViewport() {
      return a.view
    },
    attach(el: LayerElements, ev: AdapterEvents) {
      a.events = ev
      host.append(el.base, el.overlay, el.tooltip)
      return () => {
        a.events = null
      }
    },
  }
  return a
}

const styles: SceneStyles = {
  nodes: [
    { radius: 4, fill: '#333' },
    { radius: 6, fill: '#e11', stroke: '#fff', strokeWidth: 1 },
  ],
  edges: [{ color: '#888', width: 2 }],
}

/** Three nodes in a row (screen = unit with the default fake view) and two edges. */
function lineScene() {
  const b = new SceneBuilder()
  const a = b.node(100, 100)
  const c = b.node(300, 100)
  const d = b.node(300, 400, 1)
  b.edge(a, c)
  b.edge(c, d)
  return b.build()
}

const layers: GraphLayer[] = []
afterEach(() => {
  for (const l of layers.splice(0)) l.destroy()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function make(adapter: FakeAdapter, opts: Partial<Parameters<typeof createGraphLayer>[1]> = {}) {
  const layer = createGraphLayer(adapter, { scene: lineScene(), styles, renderer: 'canvas', ...opts })
  layers.push(layer)
  return layer
}

const baseCtx = (a: FakeAdapter): Recording2d => contexts.get(a.host.querySelector('canvas.skeinmap-base')!)!
const overlayCtx = (a: FakeAdapter): Recording2d => contexts.get(a.host.querySelector('canvas.skeinmap-overlay')!)!

describe('createGraphLayer (Canvas 2D)', () => {
  it('mounts its elements and draws every visible node and edge', () => {
    const a = fakeAdapter()
    const layer = make(a)
    expect(layer.backend).toBe('canvas')
    expect(a.host.querySelectorAll('canvas')).toHaveLength(2)
    const ctx = baseCtx(a)
    expect(ctx.count('arc')).toBe(3)
    expect(layer.stats.drawn).toBe(5)
    expect(layer.stats.instances).toBe(5)
  })

  it('culls what is outside the view', () => {
    const a = fakeAdapter({ centerX: 2000, centerY: 2000 })
    make(a)
    expect(baseCtx(a).count('arc')).toBe(0)
  })

  it('picks nodes before edges, within the hit radius', () => {
    const layer = make(fakeAdapter())
    expect(layer.pick(102, 99)).toEqual({ kind: 'node', index: 0 })
    expect(layer.pick(200, 103)).toEqual({ kind: 'edge', index: 0 })
    expect(layer.pick(303, 250)).toEqual({ kind: 'edge', index: 1 })
    expect(layer.pick(200, 300)).toBeNull()
  })

  it('reports clicks to the handlers and tells the adapter when one hit', () => {
    const a = fakeAdapter()
    const onNodeClick = vi.fn()
    const onEdgeClick = vi.fn()
    make(a, { onNodeClick, onEdgeClick })
    expect(a.events!.click(300, 400)).toBe(true)
    expect(onNodeClick).toHaveBeenCalledWith(2)
    expect(a.events!.click(200, 100)).toBe(true)
    expect(onEdgeClick).toHaveBeenCalledWith(0)
    expect(a.events!.click(600, 500)).toBe(false)
  })

  it('shows a tooltip and a pointer cursor on hover, and hides them on leave', async () => {
    const a = fakeAdapter()
    const onHover = vi.fn()
    make(a, { nodeTooltip: (i) => `node ${i}`, onNodeClick: () => {}, onHover })
    a.events!.pointerMove(300, 100)
    await flushFrames()
    const tip = a.host.querySelector('.skeinmap-tooltip') as HTMLDivElement
    expect(tip.style.display).toBe('block')
    expect(tip.textContent).toBe('node 1')
    expect(a.host.style.cursor).toBe('pointer')
    expect(onHover).toHaveBeenLastCalledWith({ kind: 'node', index: 1 })
    a.events!.pointerLeave()
    expect(tip.style.display).toBe('none')
    expect(onHover).toHaveBeenLastCalledWith(null)
  })

  it('renders tooltip text as text unless tooltipHtml is set', async () => {
    const a = fakeAdapter()
    make(a, { nodeTooltip: () => '<b>x</b>' })
    a.events!.pointerMove(100, 100)
    await flushFrames()
    const tip = a.host.querySelector('.skeinmap-tooltip') as HTMLDivElement
    expect(tip.innerHTML).toBe('&lt;b&gt;x&lt;/b&gt;')
  })

  it('labels nodes and drops a colliding lower-priority label', () => {
    const b = new SceneBuilder()
    b.node(100, 100)
    b.node(104, 100)
    b.node(400, 300)
    const a = fakeAdapter()
    make(a, { scene: b.build(), nodeLabel: (i) => `n${i}`, labelPriority: (i) => (i === 1 ? 2 : 1) })
    const texts = overlayCtx(a)
      .calls.filter((c) => c.name === 'fillText')
      .map((c) => c.args[0])
    expect(texts).toEqual(['n1', 'n2'])
  })

  it('does not label when labels are off', async () => {
    const a = fakeAdapter()
    const layer = make(a, { nodeLabel: (i) => `n${i}` })
    expect(overlayCtx(a).count('fillText')).toBe(3)
    overlayCtx(a).reset()
    layer.setOptions({ labels: false })
    await flushFrames()
    expect(overlayCtx(a).count('fillText')).toBe(0)
  })

  it('restyle repaints without re-projecting; setScene re-projects', async () => {
    const spy = vi.spyOn(tsKernels, 'projectMercator')
    const b = new SceneBuilder()
    b.node(0, 0)
    b.node(1, 1)
    b.edge(0, 1)
    const scene = b.build()
    const a = fakeAdapter({ k: 1024, centerX: 128, centerY: 128 }, MERCATOR)
    const layer = make(a, { scene })
    expect(spy).toHaveBeenCalledTimes(1)
    scene.nodeStyle[0] = 1
    layer.restyle()
    await flushFrames()
    expect(spy).toHaveBeenCalledTimes(1)
    layer.setScene(scene)
    await flushFrames()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('coalesces several updates into one paint', async () => {
    const a = fakeAdapter()
    const layer = make(a)
    const ctx = baseCtx(a)
    ctx.reset()
    layer.restyle()
    layer.redraw()
    layer.setScene(lineScene())
    expect(ctx.count('clearRect')).toBe(0)
    await flushFrames()
    expect(ctx.count('clearRect')).toBe(1)
  })

  it('repaints synchronously on a view change', () => {
    const a = fakeAdapter()
    make(a)
    const ctx = baseCtx(a)
    ctx.reset()
    a.view = { ...a.view, centerX: 5000 }
    a.events!.view()
    expect(ctx.count('clearRect')).toBe(1)
    expect(ctx.count('arc')).toBe(0)
  })

  it('handles rotation in drawing and picking', () => {
    // Rotated a quarter turn clockwise: a node 100 units right of centre is drawn below it.
    const b = new SceneBuilder()
    b.node(500, 300)
    const a = fakeAdapter({ rotation: Math.PI / 2 })
    const layer = make(a, { scene: b.build() })
    const arc = baseCtx(a).calls.find((c) => c.name === 'arc')!
    expect(arc.args[0]).toBeCloseTo(400)
    expect(arc.args[1]).toBeCloseTo(400)
    expect(layer.pick(400, 400)).toEqual({ kind: 'node', index: 0 })
    expect(layer.pick(500, 300)).toBeNull()
  })

  it('simplifies a dense straight polyline on the Canvas 2D path', () => {
    const b = new SceneBuilder()
    const a0 = b.node(100, 100)
    const a1 = b.node(700, 100)
    const path: [number, number][] = []
    for (let i = 0; i <= 600; i++) path.push([100 + i, 100 + (i % 2) * 1e-4])
    b.edge(a0, a1, 0, path)
    const a = fakeAdapter()
    make(a, { scene: b.build() })
    expect(baseCtx(a).count('lineTo')).toBeLessThan(5)
  })

  it('picks along a routed edge, not its chord', () => {
    const b = new SceneBuilder()
    const a0 = b.node(100, 100)
    const a1 = b.node(300, 100)
    b.edge(a0, a1, 0, [
      [100, 100],
      [200, 250],
      [300, 100],
    ])
    const layer = make(fakeAdapter(), { scene: b.build() })
    expect(layer.pick(200, 100)).toBeNull()
    expect(layer.pick(200, 248)).toEqual({ kind: 'edge', index: 0 })
  })

  it('destroy removes its elements and detaches', () => {
    const a = fakeAdapter()
    const layer = make(a)
    layer.destroy()
    expect(a.host.querySelectorAll('canvas')).toHaveLength(0)
    expect(a.host.querySelector('.skeinmap-tooltip')).toBeNull()
    expect(a.events).toBeNull()
  })
})

describe('zoomScale', () => {
  it('is 1 from the full zoom up and min at the low zoom and below', () => {
    expect(zoomScale(10)).toBe(1)
    expect(zoomScale(8)).toBe(1)
    expect(zoomScale(3)).toBe(0.5)
    expect(zoomScale(0)).toBe(0.5)
    expect(zoomScale(5.5)).toBeCloseTo(0.75)
  })
})
