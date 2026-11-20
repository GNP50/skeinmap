// Copy the non-JS assets of the package into dist/: the .wasm binary and the stylesheet.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const assets = [
  ['src/wasm/pkg/skeinmap_wasm_bg.wasm', 'dist/skeinmap_wasm_bg.wasm'],
  ['src/style.css', 'dist/style.css'],
]
mkdirSync(`${root}dist`, { recursive: true })
for (const [from, to] of assets) {
  if (!existsSync(root + from)) {
    console.error(`missing ${from} — run "npm run build:wasm" first`)
    process.exit(1)
  }
  copyFileSync(root + from, root + to)
  console.log(`${to} (${statSync(root + to).size} bytes)`)
}
