import type { LodGeometry, LodLevel } from '../kernels/types'

/** Messages to the level-of-detail worker. */
export type LodWorkerRequest =
  | { type: 'geometry'; sceneId: number; geometry: LodGeometry }
  | { type: 'level'; sceneId: number; zoom: number }
  /** Optional: load the WebAssembly kernels inside the worker (URL of the `.wasm`). */
  | { type: 'wasm'; url: string }

/** Messages from the level-of-detail worker. */
export interface LodWorkerResponse {
  sceneId: number
  level: LodLevel
}
