// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AdapterEvents, LayerElements, MapAdapter, Viewport } from '../src/adapter'
import { createPanZoomAdapter } from '../src/adapters/panzoom'
import { createGraphLayer, pointInPolygon, type GraphLayer } from '../src/layer'
import { IDENTITY, MERCATOR, mercatorUnit, type Projection } from '../src/projection'
import { HIDDEN, SceneBuilder, rgba, validateScene } from '../src/scene'
import { packColor, type SceneStyles } from '../src/styles'
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
    getViewport: () => a.view,
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
  nodes: [{ radius: 4, fill: '#333' }],
  edges: [
    { color: '#888', width: 2 },
    { color: '#e11', width: 1, arrow: 8 },
  ],
}

const layers: GraphLayer[] = []
afterEach(() => {
  for (const l of layers.splice(0)) l.destroy()
  document.body.innerHTML = ''
})

const base = (a: FakeAdapter): Recording2d => contexts.get(a.host.querySelector('canvas.skeinmap-base')!)!

/** Three nodes in a row and two edges, screen = unit in the default fake view. */
function row() {
  const b = new SceneBuilder()
  b.node(100, 100)
  b.node(300, 100)
  b.node(500, 100)
  b.edge(0, 1)
  b.edge(1, 2)
  return b.build()
}

function make(a: FakeAdapter, opts: Partial<Parameters<typeof createGraphLayer>[1]> = {}) {
  const layer = createGraphLayer(a, { scene: row(), styles, renderer: 'canvas', ...opts })
  layers.push(layer)
  return layer
}

describe('filters', () => {
  it('hide nodes, their dangling edges, and keep the caller scene untouched', async () => {
    const a = fakeAdapter()
    const layer = make(a)
    const scene = layer.scene
    base(a).reset()
    layer.setFilter({ nodes: Uint8Array.from([1, 0, 1]) })
    await flushFrames()
    expect(base(a).count('arc')).toBe(2)
    expect(base(a).count('lineTo')).toBe(0)
    expect(layer.pick(300, 100)).toBeNull()
    expect(layer.pick(200, 100)).toBeNull()
    expect(Array.from(scene.nodeStyle)).toEqual([0, 0, 0])
    expect(layer.scene).toBe(scene)
    layer.setFilter(null)
    await flushFrames()
    expect(layer.pick(300, 100)).toEqual({ kind: 'node', index: 1 })
  })

  it('can keep dangling edges and hide edges on their own', async () => {
    const a = fakeAdapter()
    const layer = make(a)
    base(a).reset()
    layer.setFilter({ nodes: Uint8Array.from([1, 0, 1]), hideDanglingEdges: false })
    await flushFrames()
    expect(base(a).count('lineTo')).toBe(2)
    base(a).reset()
    layer.setFilter({ edges: Uint8Array.from([0, 1]) })
    await flushFrames()
    expect(base(a).count('lineTo')).toBe(1)
    expect(layer.pick(200, 102)).toBeNull()
    expect(layer.pick(400, 102)).toEqual({ kind: 'edge', index: 1 })
  })

  it('treats style byte 255 in the scene itself as hidden', () => {
    const s = row()
    s.nodeStyle[2] = HIDDEN
    expect(validateScene(s)).toEqual([])
    const a = fakeAdapter()
    const layer = make(a, { scene: s })
    expect(base(a).count('arc')).toBe(2)
    // Without a filter there is no dangling-edge rule: the edge into it is still there.
    expect(layer.pick(500, 100)).toEqual({ kind: 'edge', index: 1 })
    expect(layer.pick(500, 110)).toBeNull()
  })

  it('excludes hidden nodes from labels', async () => {
    const a = fakeAdapter()
    const layer = make(a, { nodeLabel: (i) => `n${i}` })
    layer.setFilter({ nodes: Uint8Array.from([0, 1, 1]) })
    await flushFrames()
    const octx = contexts.get(a.host.querySelector('canvas.skeinmap-overlay')!)!
    const texts = octx.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])
    expect(texts.slice(-2)).toEqual(['n1', 'n2'])
  })
})

describe('per-element colour and size', () => {
  it('packs colours', () => {
    expect(rgba(255, 0, 128, 1)).toBe(0xff0080ff)
    expect(packColor('#ff0080')).toBe(0xff0080ff)
    expect(packColor('rgba(0, 0, 255, 0.5)')).toBe(0x0000ff80)
  })

  it('draws a node with its own colour and radius, and picks with that radius', async () => {
    const s = row()
    s.nodeColor = new Uint32Array([0, rgba(255, 0, 0), 0])
    s.nodeRadius = new Float32Array([0, 20, 0])
    const a = fakeAdapter()
    const layer = make(a, { scene: s })
    const arcs = base(a).calls.filter((c) => c.name === 'arc')
    expect(arcs.map((c) => c.args[2])).toContain(20)
    expect(layer.pick(300, 118)).toEqual({ kind: 'node', index: 1 })
    expect(layer.pick(100, 112)).toBeNull()
    // Rewritten in place, picked up by restyle().
    s.nodeRadius[1] = 0
    layer.restyle()
    await flushFrames()
    expect(layer.pick(300, 118)).toBeNull()
  })

  it('uses per-edge colour and width', () => {
    const s = row()
    s.edgeColor = new Uint32Array([rgba(0, 0, 255), 0])
    s.edgeWidth = new Float32Array([6, 0])
    const a = fakeAdapter()
    make(a, { scene: s })
    expect(base(a).count('stroke')).toBeGreaterThanOrEqual(2)
  })
})

describe('arrows', () => {
  it('draws an arrowhead at the target rim for styles with arrow', () => {
    const s = row()
    s.edgeStyle[1] = 1
    const a = fakeAdapter()
    make(a, { scene: s })
    const fills = base(a).calls.filter((c) => c.name === 'moveTo')
    // The arrow tip sits on node 2's rim (radius 4) on the incoming side: x = 496.
    expect(fills.some((c) => Math.abs((c.args[0] as number) - 496) < 1e-9 && c.args[1] === 100)).toBe(true)
  })
})

describe('queries', () => {
  it('finds visible nodes in a box and in a polygon', async () => {
    const layer = make(fakeAdapter())
    expect(Array.from(layer.queryBox(350, 0, 50, 200))).toEqual([0, 1])
    const tri: [number, number][] = [
      [250, 50],
      [600, 50],
      [425, 300],
    ]
    expect(Array.from(layer.queryPolygon(tri))).toEqual([1, 2])
    layer.setFilter({ nodes: Uint8Array.from([1, 0, 1]) })
    await flushFrames()
    expect(Array.from(layer.queryBox(0, 0, 800, 600))).toEqual([0, 2])
  })

  it('pointInPolygon follows the even-odd rule', () => {
    const square: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    expect(pointInPolygon(5, 5, square)).toBe(true)
    expect(pointInPolygon(15, 5, square)).toBe(false)
  })
})

describe('world copies', () => {
  it('draws and picks a node on the copy to the right of the world', () => {
    const b = new SceneBuilder()
    b.node(0, 0) // lon 0, lat 0 → units (128, 128)
    const ux = new Float64Array(1)
    const uy = new Float64Array(1)
    mercatorUnit(0, 0, ux, uy, 0)
    // Zoom 1 (k = 2): the world is 512 px; centre the view on the seam at x = 256 units.
    const a = fakeAdapter({ k: 2, centerX: 256, centerY: 128, width: 1200, height: 400 }, MERCATOR)
    const layer = make(a, { scene: b.build(), worldCopies: true })
    const xs = base(a)
      .calls.filter((c) => c.name === 'arc')
      .map((c) => c.args[0] as number)
      .sort((p, q) => p - q)
    // Copy 0 at (128 − 256)·2 + 600 = 344, copy 1 at 344 + 512 = 856.
    expect(xs).toEqual([344, 856])
    expect(layer.pick(856, 200)).toEqual({ kind: 'node', index: 0 })
    expect(layer.pick(344, 200)).toEqual({ kind: 'node', index: 0 })
    void ux
    void uy
  })

  it('draws once without worldCopies', () => {
    const b = new SceneBuilder()
    b.node(0, 0)
    const a = fakeAdapter({ k: 2, centerX: 256, centerY: 128, width: 1200, height: 400 }, MERCATOR)
    const layer = make(a, { scene: b.build() })
    expect(base(a).count('arc')).toBe(1)
    expect(layer.pick(856, 200)).toBeNull()
  })
})

describe('pan/zoom keyboard and box selection', () => {
  function host() {
    const el = document.createElement('div')
    Object.defineProperty(el, 'clientWidth', { value: 800 })
    Object.defineProperty(el, 'clientHeight', { value: 600 })
    el.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON() {},
    })
    document.body.appendChild(el)
    return el
  }

  it('pans and zooms with the keyboard and resets with 0', () => {
    const el = host()
    const onReset = vi.fn()
    const a = createPanZoomAdapter(el, { center: [0, 0], k: 2, onReset })
    const layer = createGraphLayer(a, { scene: row(), styles, renderer: 'canvas' })
    layers.push(layer)
    expect(el.tabIndex).toBe(0)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    expect(a.view.centerX).toBe(40)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }))
    expect(a.view.k).toBe(3)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: '0' }))
    expect(onReset).toHaveBeenCalled()
  })

  it('reports a shift-drag box instead of panning', () => {
    const el = host()
    const onBoxSelect = vi.fn()
    const a = createPanZoomAdapter(el, { center: [400, 300], k: 1, onBoxSelect })
    const layer = createGraphLayer(a, { scene: row(), styles, renderer: 'canvas' })
    layers.push(layer)
    const pe = (type: string, x: number, y: number) => {
      const e = new MouseEvent(type, { clientX: x, clientY: y, shiftKey: true, bubbles: true })
      Object.defineProperty(e, 'pointerId', { value: 3 })
      el.dispatchEvent(e)
    }
    pe('pointerdown', 50, 50)
    expect(el.querySelector('.skeinmap-selection')).not.toBeNull()
    pe('pointermove', 350, 150)
    pe('pointerup', 350, 150)
    expect(el.querySelector('.skeinmap-selection')).toBeNull()
    expect(onBoxSelect).toHaveBeenCalledWith({ x0: 50, y0: 50, x1: 350, y1: 150 })
    expect(a.view.centerX).toBe(400)
    const box = onBoxSelect.mock.calls[0][0]
    expect(Array.from(layer.queryBox(box.x0, box.y0, box.x1, box.y1))).toEqual([0, 1])
  })
})
