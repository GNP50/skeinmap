import { tsKernels } from './ts'
import type { Kernels } from './types'
import { defaultWasmSource } from '#wasm-source'

/**
 * Which kernels run: WebAssembly once {@link initWasm} has succeeded, the TypeScript
 * fallback before that, after a failure, or when asked for with
 * {@link setKernelPreference}. Initialising is optional and asynchronous; nothing waits
 * for it — the layer simply runs faster once it is ready.
 *
 * @module
 */

/** `auto` uses WebAssembly when it is loaded; `ts` and `wasm` force one (`wasm` falls
 *  back to TypeScript while the module is not loaded). */
export type KernelPreference = 'auto' | 'wasm' | 'ts'

/** Lifecycle of the WebAssembly module. */
export type WasmStatus = 'idle' | 'loading' | 'ready' | 'failed'

/**
 * Where the `.wasm` binary comes from. With no argument, the ESM build resolves the file
 * next to itself (`new URL('./skeinmap_wasm_bg.wasm', import.meta.url)`), which Vite,
 * webpack 5 and Next.js turn into an emitted asset; the CommonJS build reads it from disk
 * under Node.
 */
export type WasmSource =
  string | URL | Response | Promise<Response> | ArrayBuffer | ArrayBufferView | WebAssembly.Module

export interface InitWasmOptions {
  /** Reject instead of resolving `false` when the module cannot be loaded. */
  throwOnError?: boolean
}

let preference: KernelPreference = 'auto'
let wasmKernels: Kernels | null = null
let status: WasmStatus = 'idle'
let lastError: unknown = null
let loading: Promise<boolean> | null = null
const listeners = new Set<() => void>()

/** The kernels to use right now. Cheap: call it at the point of use, not once. */
export function kernels(): Kernels {
  if (preference === 'ts') return tsKernels
  return wasmKernels ?? tsKernels
}

/** Prefer one implementation. Takes effect for the next kernel call. */
export function setKernelPreference(p: KernelPreference): void {
  if (p === preference) return
  preference = p
  notify()
}

export function getKernelPreference(): KernelPreference {
  return preference
}

export function wasmStatus(): WasmStatus {
  return status
}

/** Why the last {@link initWasm} failed, if it did. */
export function wasmError(): unknown {
  return lastError
}

/** Called whenever the active kernels may have changed. Returns the unsubscribe. */
export function onKernelsChange(callback: () => void): () => void {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function notify(): void {
  for (const l of [...listeners]) l()
}

function isFileUrl(source: unknown): source is URL | string {
  if (source instanceof URL) return source.protocol === 'file:'
  return typeof source === 'string' && source.startsWith('file:')
}

/** Read a `file:` URL under Node without making bundlers try to resolve `node:fs`. */
async function readFileUrl(url: URL | string): Promise<Uint8Array> {
  const specifier = 'node:fs/promises'
  const fs = (await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)) as {
    readFile(path: URL): Promise<Uint8Array>
  }
  return fs.readFile(typeof url === 'string' ? new URL(url) : url)
}

/**
 * Load the WebAssembly kernels. Resolves `true` once they are active, `false` when they
 * could not be loaded (the TypeScript kernels keep running; see {@link wasmError}).
 * Concurrent calls share one load; after a failure a later call tries again.
 *
 * Under a Content Security Policy, compiling WebAssembly needs `'wasm-unsafe-eval'` in
 * `script-src` (never `'unsafe-eval'`). Without it this resolves `false` and nothing
 * else changes.
 */
export function initWasm(source?: WasmSource, options: InitWasmOptions = {}): Promise<boolean> {
  if (wasmKernels) return Promise.resolve(true)
  if (!loading) {
    status = 'loading'
    lastError = null
    loading = (async () => {
      try {
        let input: unknown = source ?? defaultWasmSource()
        if (input == null) {
          throw new Error('No WebAssembly source: pass the .wasm URL or bytes to initWasm()')
        }
        if (isFileUrl(input)) input = await readFileUrl(input)
        const [glue, { createWasmKernels }] = await Promise.all([
          import('../wasm/pkg/skeinmap_wasm.js'),
          import('./wasm'),
        ])
        await glue.default({ module_or_path: input as never })
        wasmKernels = createWasmKernels(glue)
        status = 'ready'
        notify()
        return true
      } catch (err) {
        status = 'failed'
        lastError = err
        loading = null
        notify()
        return false
      }
    })()
  }
  const pending = loading
  return options.throwOnError
    ? pending.then((ok) => {
        if (!ok) throw lastError instanceof Error ? lastError : new Error(String(lastError))
        return true
      })
    : pending
}

/** Drop the loaded module (tests). The next {@link initWasm} loads it again. */
export function resetWasmForTesting(): void {
  wasmKernels = null
  status = 'idle'
  lastError = null
  loading = null
  notify()
}

export { tsKernels }
export type * from './types'
