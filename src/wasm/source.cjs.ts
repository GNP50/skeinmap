/**
 * Default location of the `.wasm` binary for the CommonJS build: read from disk under
 * Node. A browser bundle built from the CommonJS entry has no default; pass the URL or
 * the bytes to `initWasm()` (bundlers normally pick the ESM entry instead).
 */
declare const require: (id: string) => unknown
declare const __dirname: string

export function defaultWasmSource(): Uint8Array | null {
  if (typeof process === 'undefined' || !process.versions?.node || typeof require !== 'function') return null
  const fs = require('node:fs') as { readFileSync(path: string): Uint8Array }
  const path = require('node:path') as { join(...parts: string[]): string }
  return fs.readFileSync(path.join(__dirname, 'skeinmap_wasm_bg.wasm'))
}
