/// <reference lib="webworker" />
/**
 * Level-of-detail worker. Binning a million nodes is tens of milliseconds per zoom level:
 * fine here, a visible stall on the UI thread in the middle of a zoom. The geometry
 * crosses once per scene (transferred typed arrays); each request after that is a zoom
 * level, and the answer comes back as transferred index arrays.
 *
 * Use it by handing the layer a factory:
 *
 * ```ts
 * createGraphLayer(adapter, {
 *   lod: { worker: () => new Worker(new URL('skeinmap/lod-worker', import.meta.url), { type: 'module' }) },
 * })
 * ```
 *
 * @module
 */
import { initWasm, kernels } from './kernels/index'
import type { LodComputer } from './kernels/types'
import type { LodWorkerRequest, LodWorkerResponse } from './lod/protocol'

let current: { sceneId: number; computer: LodComputer } | null = null
let pendingGeometry: Extract<LodWorkerRequest, { type: 'geometry' }> | null = null

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<LodWorkerRequest>) => void) | null
  postMessage(message: unknown, transfer: Transferable[]): void
}

scope.onmessage = (event) => {
  const msg = event.data
  if (msg.type === 'wasm') {
    void initWasm(msg.url)
    return
  }
  if (msg.type === 'geometry') {
    current?.computer.dispose()
    current = null
    pendingGeometry = msg
    return
  }
  if (pendingGeometry && pendingGeometry.sceneId === msg.sceneId) {
    current = { sceneId: msg.sceneId, computer: kernels().createLod(pendingGeometry.geometry) }
    pendingGeometry = null
  }
  // A request for a scene that has since been replaced is dropped.
  if (!current || current.sceneId !== msg.sceneId) return
  const level = current.computer.level(msg.zoom)
  const response: LodWorkerResponse = { sceneId: msg.sceneId, level }
  scope.postMessage(response, [level.nodes.buffer, level.segEdge.buffer, level.segP0.buffer, level.segP1.buffer])
}
