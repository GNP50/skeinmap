import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { MapAdapter } from '../adapter'
import { createPanZoomAdapter, type PanZoomAdapter, type PanZoomOptions } from '../adapters/panzoom'
import { createGraphLayer, type GraphLayer, type GraphLayerOptions } from '../layer'
import { sceneBounds, type Scene } from '../scene'

/**
 * React bindings: a hook that keeps a layer in step with props on any adapter, and a
 * component for the standalone pan/zoom view. Callbacks are read through a ref, so
 * inline closures do not rebuild anything; a new `scene` object re-projects, and the
 * other options are applied with `setOptions` when they change.
 *
 * @module
 */

export type UseGraphLayerOptions = Omit<GraphLayerOptions, 'scene'>

const CALLBACKS = [
  'onNodeClick',
  'onEdgeClick',
  'onHover',
  'nodeTooltip',
  'edgeTooltip',
  'nodeLabel',
  'labelPriority',
] as const satisfies readonly (keyof UseGraphLayerOptions)[]

type CallbackKey = (typeof CALLBACKS)[number]

/** Options whose identity changing would otherwise call `setOptions` every render. */
function stableOptions(
  ref: RefObject<UseGraphLayerOptions>,
  current: UseGraphLayerOptions,
): Partial<GraphLayerOptions> {
  const out: Partial<GraphLayerOptions> = {}
  for (const [key, value] of Object.entries(current) as [keyof UseGraphLayerOptions, unknown][]) {
    if ((CALLBACKS as readonly string[]).includes(key)) continue
    ;(out as Record<string, unknown>)[key] = value
  }
  for (const key of CALLBACKS) {
    // Wired only when given: a click handler makes the layer swallow map clicks.
    if (current[key]) {
      ;(out as Record<string, unknown>)[key] = (...args: unknown[]) =>
        (ref.current[key] as ((...a: unknown[]) => unknown) | undefined)?.(...args)
    } else {
      ;(out as Record<string, unknown>)[key] = undefined
    }
  }
  return out
}

function shallowChanged(a: Record<string, unknown>, b: Record<string, unknown>, skip: readonly string[]): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (skip.includes(k)) continue
    if (a[k] !== b[k]) return true
  }
  return false
}

/**
 * Mount a graph layer on `adapter` and keep it in step: created when both `adapter` and
 * `scene` are non-null, `setScene` on every new scene object, destroyed when either goes
 * back to null and on unmount. Returns a ref to the layer (for `restyle()` after an
 * in-place style-byte write, or `stats`).
 */
export function useGraphLayer(
  adapter: MapAdapter | null,
  scene: Scene | null,
  options: UseGraphLayerOptions,
): RefObject<GraphLayer | null> {
  const layerRef = useRef<GraphLayer | null>(null)
  const optionsRef = useRef(options)
  const appliedRef = useRef<UseGraphLayerOptions>(options)
  const presenceRef = useRef<string>('')
  optionsRef.current = options

  // Create / destroy with the adapter.
  useEffect(() => {
    if (!adapter || !scene) return
    const layer = createGraphLayer(adapter, {
      ...stableOptions(optionsRef, optionsRef.current),
      scene,
    } as GraphLayerOptions)
    layerRef.current = layer
    appliedRef.current = optionsRef.current
    presenceRef.current = CALLBACKS.map((k) => (optionsRef.current[k] ? '1' : '0')).join('')
    return () => {
      layer.destroy()
      if (layerRef.current === layer) layerRef.current = null
    }
    // `scene` presence (not identity) is a dependency: the next effect handles changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, scene === null])

  // A new scene object re-projects.
  useEffect(() => {
    const layer = layerRef.current
    if (layer && scene && layer.scene !== scene) layer.setScene(scene)
  }, [scene])

  // Other options: apply when a non-callback value changed, or a callback appeared/vanished.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const presence = CALLBACKS.map((k) => (options[k] ? '1' : '0')).join('')
    const changed =
      presence !== presenceRef.current ||
      shallowChanged(
        appliedRef.current as Record<string, unknown>,
        options as Record<string, unknown>,
        CALLBACKS as readonly CallbackKey[],
      )
    if (!changed) return
    layer.setOptions(stableOptions(optionsRef, options))
    appliedRef.current = options
    presenceRef.current = presence
  })

  return layerRef
}

export interface GraphCanvasHandle {
  readonly layer: GraphLayer | null
  readonly adapter: PanZoomAdapter | null
  /** Fit the view to the current scene. */
  fit(padding?: number): void
}

export interface GraphCanvasProps extends UseGraphLayerOptions {
  scene: Scene | null
  /** Pan/zoom settings, read once at mount. */
  view?: PanZoomOptions
  /** Fit the view to the first non-empty scene. Default true. */
  fitOnLoad?: boolean
  className?: string
  style?: CSSProperties
}

/**
 * A self-contained pan/zoom view drawing `scene` — no map library needed. Size it with
 * `className`/`style` (it fills its box). Pass a ref for {@link GraphCanvasHandle}.
 */
export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(
  { scene, view, fitOnLoad = true, className, style, ...options },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [adapter, setAdapter] = useState<PanZoomAdapter | null>(null)
  const fittedRef = useRef(false)

  useEffect(() => {
    if (!hostRef.current) return
    const a = createPanZoomAdapter(hostRef.current, view)
    setAdapter(a)
    return () => {
      a.dispose()
      setAdapter(null)
    }
    // `view` is read once, at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const layerRef = useGraphLayer(adapter, scene, options)

  useEffect(() => {
    if (!adapter || !scene || !fitOnLoad || fittedRef.current) return
    const b = sceneBounds(scene)
    if (!b) return
    fittedRef.current = true
    adapter.fitBounds(b)
  }, [adapter, scene, fitOnLoad])

  useImperativeHandle(
    ref,
    () => ({
      get layer() {
        return layerRef.current
      },
      get adapter() {
        return adapter
      },
      fit(padding?: number) {
        const b = scene && sceneBounds(scene)
        if (adapter && b) adapter.fitBounds(b, padding)
      },
    }),
    [adapter, scene, layerRef],
  )

  return <div ref={hostRef} className={className} style={{ position: 'relative', overflow: 'hidden', ...style }} />
})
