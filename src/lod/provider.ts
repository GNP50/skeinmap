import { kernels } from '../kernels/index'
import type { LodComputer, LodGeometry, LodLevel } from '../kernels/types'
import type { LodWorkerRequest, LodWorkerResponse } from './protocol'

/**
 * Hands levels of detail to the layer: computed in a Web Worker when the caller supplies
 * one, otherwise inline on a later task (so the frame that asked is not the one that
 * pays). Asynchronous either way: the layer draws the full scene until a level arrives.
 */
export interface LodProvider {
  /** New geometry; outstanding requests for the previous one are dropped. */
  setGeometry(sceneId: number, geometry: LodGeometry): void
  request(sceneId: number, zoom: number): void
  dispose(): void
}

export function createLodProvider(
  onLevel: (sceneId: number, level: LodLevel) => void,
  makeWorker?: () => Worker,
): LodProvider {
  let worker: Worker | null = null
  let inline: { sceneId: number; geometry: LodGeometry; computer: LodComputer | null } | null = null
  const inFlight: { sceneId: number; zoom: number }[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const computeInline = (sceneId: number, zoom: number) => {
    const g = inline
    if (!g || g.sceneId !== sceneId) return
    const t = setTimeout(() => {
      timers.delete(t)
      if (inline !== g) return
      // Created on first use with whichever kernels are active then.
      if (!g.computer) g.computer = kernels().createLod(g.geometry)
      onLevel(sceneId, g.computer.level(zoom))
    }, 0)
    timers.add(t)
  }

  if (makeWorker) {
    try {
      worker = makeWorker()
      worker.onmessage = (e: MessageEvent<LodWorkerResponse>) => {
        const i = inFlight.findIndex((r) => r.sceneId === e.data.sceneId && r.zoom === e.data.level.zoom)
        if (i >= 0) inFlight.splice(i, 1)
        onLevel(e.data.sceneId, e.data.level)
      }
      worker.onerror = () => {
        // A worker that cannot load (CSP worker-src, bundler output): compute inline.
        worker?.terminate()
        worker = null
        for (const r of inFlight.splice(0)) computeInline(r.sceneId, r.zoom)
      }
    } catch {
      worker = null
    }
  }

  return {
    setGeometry(sceneId, geometry) {
      inline?.computer?.dispose()
      inline = { sceneId, geometry, computer: null }
      if (!worker) return
      // Copies, so the layer keeps its own arrays; the copies are transferred.
      const copy: LodGeometry = {
        nodeCount: geometry.nodeCount,
        unitX: geometry.unitX.slice(0, geometry.nodeCount),
        unitY: geometry.unitY.slice(0, geometry.nodeCount),
        nodeStyle: geometry.nodeStyle.slice(0, geometry.nodeCount),
        edgeCount: geometry.edgeCount,
        edgeFrom: geometry.edgeFrom.slice(0, geometry.edgeCount),
        edgeTo: geometry.edgeTo.slice(0, geometry.edgeCount),
        edgeStyle: geometry.edgeStyle.slice(0, geometry.edgeCount),
        edgePathStart: geometry.edgePathStart?.slice(0, geometry.edgeCount),
        edgePathEnd: geometry.edgePathEnd?.slice(0, geometry.edgeCount),
        unitPX: geometry.unitPX?.slice(),
        unitPY: geometry.unitPY?.slice(),
        bounds: geometry.bounds,
      }
      const transfer = [
        copy.unitX,
        copy.unitY,
        copy.nodeStyle,
        copy.edgeFrom,
        copy.edgeTo,
        copy.edgeStyle,
        copy.edgePathStart,
        copy.edgePathEnd,
        copy.unitPX,
        copy.unitPY,
      ]
        .filter((a): a is NonNullable<typeof a> => a != null)
        .map((a) => a.buffer as ArrayBuffer)
      const msg: LodWorkerRequest = { type: 'geometry', sceneId, geometry: copy }
      worker.postMessage(msg, transfer)
    },
    request(sceneId, zoom) {
      if (worker) {
        inFlight.push({ sceneId, zoom })
        const msg: LodWorkerRequest = { type: 'level', sceneId, zoom }
        worker.postMessage(msg)
        return
      }
      computeInline(sceneId, zoom)
    },
    dispose() {
      worker?.terminate()
      worker = null
      for (const t of timers) clearTimeout(t)
      timers.clear()
      inline?.computer?.dispose()
      inline = null
    },
  }
}
