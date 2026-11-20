#!/usr/bin/env node
// Builds the demo (examples/demo) into docs/public/demo/, so VitePress copies it into the
// site. The demo's base path follows the site's: DOCS_BASE (default "/") + "demo/".
//
// Usage: node scripts/build-demo.mjs        (DOCS_BASE=/sub/path/ to match the site)

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build, createLogger } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const glue = `${root}src/wasm/pkg/skeinmap_wasm.js`

if (!existsSync(glue)) {
  console.error(
    'build-demo: src/wasm/pkg/skeinmap_wasm.js is missing. The demo bundles the WebAssembly\n' +
      'kernels from the sources: run "npm run build:wasm" first (needs Rust, the\n' +
      'wasm32-unknown-unknown target and wasm-bindgen-cli; see docs/guide/contributing.md).',
  )
  process.exit(1)
}

function normaliseBase(value) {
  let b = value.trim() || '/'
  if (!b.startsWith('/')) b = `/${b}`
  if (!b.endsWith('/')) b = `${b}/`
  return b
}

const base = `${normaliseBase(process.env.DOCS_BASE ?? '/')}demo/`
const outDir = `${root}docs/public/demo`

// From the sources, the library's default .wasm URL (next to src/wasm/source.ts) does not
// exist; the demo passes the URL of src/wasm/pkg/*.wasm to initWasm() instead. Drop the
// warning Vite prints about the unresolved default so real warnings stand out.
const logger = createLogger('warn')
const known = (msg) => msg.includes('skeinmap_wasm_bg.wasm') && msg.includes("doesn't exist at build time")
for (const level of ['warn', 'warnOnce', 'info']) {
  const original = logger[level]
  logger[level] = (msg, options) => {
    if (!known(String(msg))) original(msg, options)
  }
}

await build({
  configFile: `${root}examples/demo/vite.config.ts`,
  base,
  logLevel: 'warn',
  customLogger: logger,
  build: { outDir, emptyOutDir: true },
})

console.log(`build-demo: built examples/demo into docs/public/demo/ (base ${base})`)
