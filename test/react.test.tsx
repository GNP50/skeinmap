// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { GraphCanvas, type GraphCanvasHandle } from '../src/react/index'
import { SceneBuilder, type Scene } from '../src/scene'
import { installFakeCanvas } from './helpers/fakeCanvas'

beforeAll(() => {
  installFakeCanvas()
  // jsdom does no layout: give every element a size so the view is not empty.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

function scene(n: number): Scene {
  const b = new SceneBuilder()
  for (let i = 0; i < n; i++) b.node(i * 10, i * 5)
  for (let i = 1; i < n; i++) b.edge(i - 1, i)
  return b.build()
}

const styles = { nodes: [{ radius: 3, fill: '#000' }], edges: [{ color: '#999', width: 1 }] }

describe('<GraphCanvas>', () => {
  it('creates a layer, follows scene changes and destroys it on unmount', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const ref = createRef<GraphCanvasHandle>()
    const first = scene(3)
    await act(async () => {
      root.render(<GraphCanvas ref={ref} scene={first} styles={styles} renderer="canvas" />)
    })
    expect(ref.current?.layer?.scene).toBe(first)
    expect(container.querySelectorAll('canvas')).toHaveLength(2)

    const second = scene(5)
    await act(async () => {
      root.render(<GraphCanvas ref={ref} scene={second} styles={styles} renderer="canvas" />)
    })
    expect(ref.current?.layer?.scene).toBe(second)

    await act(async () => root.unmount())
    expect(container.querySelectorAll('canvas')).toHaveLength(0)
  })

  it('calls the latest inline callback without rebuilding the layer', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const ref = createRef<GraphCanvasHandle>()
    const s = scene(2)
    const first = vi.fn()
    const second = vi.fn()
    await act(async () => {
      root.render(<GraphCanvas ref={ref} scene={s} styles={styles} renderer="canvas" onNodeClick={first} />)
    })
    const layer = ref.current!.layer
    await act(async () => {
      root.render(<GraphCanvas ref={ref} scene={s} styles={styles} renderer="canvas" onNodeClick={second} />)
    })
    expect(ref.current!.layer).toBe(layer)
    const adapter = ref.current!.adapter!
    const v = adapter.getViewport()
    const x = (0 - v.centerX) * v.k + v.width / 2
    const y = (0 - v.centerY) * v.k + v.height / 2
    expect(layer!.pick(x, y)).toEqual({ kind: 'node', index: 0 })
    const host = container.firstElementChild as HTMLElement
    host.getBoundingClientRect = () => ({
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
    for (const type of ['pointerdown', 'pointerup']) {
      const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true })
      Object.defineProperty(e, 'pointerId', { value: 1 })
      host.dispatchEvent(e)
    }
    expect(second).toHaveBeenCalledWith(0)
    expect(first).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })
})
