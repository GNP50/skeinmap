/**
 * Default location of the `.wasm` binary for the ESM build: next to this module. Written
 * as a literal `new URL(..., import.meta.url)` so bundlers (Vite, webpack 5, Next.js,
 * Parcel, Rollup with a URL plugin) emit the file as an asset and rewrite the URL.
 */
export function defaultWasmSource(): URL | null {
  return new URL('./skeinmap_wasm_bg.wasm', import.meta.url)
}
