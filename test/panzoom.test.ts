// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createPanZoomAdapter } from '../src/adapters/panzoom'
import { createGraphLayer } from '../src/layer'
import { SceneBuilder } from '../src/scene'
import { installFakeCanvas } from './helpers/fakeCanvas'

beforeAll(() => installFakeCanvas())

function host(width = 800, height = 600) {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: width })
  Object.defineProperty(el, 'clientHeight', { value: height })
  el.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    x: 0,
    y: 0,
    toJSON() {},
  })
  document.body.appendChild(el)
  return el
}

describe('createPanZoomAdapter', () => {
  it('reports a viewport from its state', () => {
    const a = createPanZoomAdapter(host(), { center: [10, 20], k: 2 })
    expect(a.getViewport()).toMatchObject({
      width: 800,
      height: 600,
      k: 2,
      centerX: 10,
      centerY: 20,
      rotation: 0,
      zoom: 1,
    })
  })

  it('fits bounds with padding', () => {
    const a = createPanZoomAdapter(host())
    a.fitBounds([0, 0, 100, 50], 50)
    expect(a.view.centerX).toBe(50)
    expect(a.view.centerY).toBe(25)
    expect(a.view.k).toBeCloseTo(7) // min(700 / 100, 500 / 50)
  })

  it('pans by dragging and zooms around the wheel position', () => {
    const el = host()
    const a = createPanZoomAdapter(el, { center: [0, 0], k: 1 })
    const b = new SceneBuilder()
    b.node(0, 0)
    const layer = createGraphLayer(a, { scene: b.build(), styles: { nodes: [], edges: [] }, renderer: 'canvas' })
    const pe = (type: string, x: number, y: number) => {
      const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }) as MouseEvent & { pointerId: number }
      Object.defineProperty(e, 'pointerId', { value: 1 })
      el.dispatchEvent(e)
    }
    pe('pointerdown', 400, 300)
    pe('pointermove', 450, 330)
    pe('pointerup', 450, 330)
    expect(a.view.centerX).toBe(-50)
    expect(a.view.centerY).toBe(-30)

    // The unit under the wheel stays put.
    const before = { x: a.view.centerX + (600 - 400) / a.view.k, y: a.view.centerY + (100 - 300) / a.view.k }
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 600, clientY: 100, cancelable: true }))
    expect(a.view.k).toBeGreaterThan(1)
    const after = { x: a.view.centerX + (600 - 400) / a.view.k, y: a.view.centerY + (100 - 300) / a.view.k }
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    layer.destroy()
    a.dispose()
  })

  it('turns a click without movement into a pick', () => {
    const el = host()
    const a = createPanZoomAdapter(el, { center: [400, 300], k: 1 })
    const b = new SceneBuilder()
    b.node(100, 100)
    const onNodeClick = vi.fn()
    const layer = createGraphLayer(a, {
      scene: b.build(),
      styles: { nodes: [], edges: [] },
      renderer: 'canvas',
      onNodeClick,
    })
    const pe = (type: string, x: number, y: number) => {
      const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true })
      Object.defineProperty(e, 'pointerId', { value: 7 })
      el.dispatchEvent(e)
    }
    pe('pointerdown', 101, 101)
    pe('pointerup', 101, 101)
    expect(onNodeClick).toHaveBeenCalledWith(0)
    layer.destroy()
  })
})
