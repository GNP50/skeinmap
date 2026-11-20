#!/usr/bin/env bash
# Smoke-test the package as a consumer sees it: pack the tarball, install it into a
# throwaway project, and check that it loads and runs under Node (ESM and CommonJS) and
# that a Vite build picks up the .wasm file as an asset.
#
# Run `npm run build` first. Set KEEP_SMOKE_DIR=1 to keep the temporary project.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f dist/index.js ] || [ ! -f dist/index.cjs ] || [ ! -f dist/skeinmap_wasm_bg.wasm ]; then
  echo "dist/ is missing or incomplete: run 'npm run build' first" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/skeinmap-smoke.XXXXXX")"
cleanup() {
  if [ "${KEEP_SMOKE_DIR:-}" = "1" ]; then
    echo "kept $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

RESULTS=()
FAILED=0
record() {
  # record <name> <exit status>
  if [ "$2" -eq 0 ]; then
    RESULTS+=("PASS  $1")
  else
    RESULTS+=("FAIL  $1")
    FAILED=1
  fi
}

echo "==> packing"
TARBALL_NAME="$(npm pack --silent --pack-destination "$WORK" | tail -n 1)"
TARBALL="$WORK/$TARBALL_NAME"
[ -f "$TARBALL" ] || { echo "npm pack produced no tarball" >&2; exit 1; }
echo "    $TARBALL_NAME"

# Use the same Vite major as the repository so the check matches what is tested here.
VITE_VERSION="$(node -p "require('./node_modules/vite/package.json').version" 2>/dev/null || echo latest)"

APP="$WORK/consumer"
mkdir -p "$APP"
cd "$APP"
cat > package.json <<'JSON'
{ "name": "skeinmap-smoke-consumer", "version": "0.0.0", "private": true }
JSON

echo "==> installing the tarball and vite@$VITE_VERSION"
npm install --silent --no-audit --no-fund --no-package-lock "$TARBALL" "vite@$VITE_VERSION"

# Shared checks: a scene, the WASM kernels, projection and one LOD level compared with
# the TypeScript kernels. Written once as a function body used by both module formats.
cat > checks.txt <<'JS'
  const failures = []
  const check = (ok, what) => {
    if (!ok) failures.push(what)
  }

  // A deterministic scene: points spread over Europe, a ring plus chords.
  let seed = 1234567
  const rand = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return seed / 2 ** 32
  }
  const b = new dg.SceneBuilder()
  const n = 3000
  for (let i = 0; i < n; i++) b.node(-10 + rand() * 40, 35 + rand() * 25, i % 3)
  for (let i = 0; i < n; i++) b.edge(i, (i + 1) % n, 0)
  for (let i = 0; i < n; i += 7) b.edge(i, Math.floor(rand() * n), 1)
  const scene = b.build()
  check(scene.nodeCount === n, 'scene node count')
  check(dg.validateScene(scene).length === 0, 'scene is valid')

  check(dg.kernels().name === 'ts', 'TypeScript kernels before initWasm()')
  const ok = await dg.initWasm(undefined, { throwOnError: true })
  check(ok === true, 'initWasm() resolved true')
  check(dg.wasmStatus() === 'ready', 'wasmStatus() is ready')
  const wasm = dg.kernels()
  check(wasm.name === 'wasm', 'kernels().name is wasm')

  const ux = new Float64Array(n)
  const uy = new Float64Array(n)
  const tx = new Float64Array(n)
  const ty = new Float64Array(n)
  wasm.projectMercator(scene.nodeX, scene.nodeY, ux, uy, n)
  dg.tsKernels.projectMercator(scene.nodeX, scene.nodeY, tx, ty, n)
  let maxDiff = 0
  for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(ux[i] - tx[i]), Math.abs(uy[i] - ty[i]))
  check(maxDiff < 1e-9, `projectMercator matches (max diff ${maxDiff})`)

  const geometry = {
    nodeCount: n,
    unitX: tx,
    unitY: ty,
    nodeStyle: scene.nodeStyle,
    edgeCount: scene.edgeCount,
    edgeFrom: scene.edgeFrom,
    edgeTo: scene.edgeTo,
    edgeStyle: scene.edgeStyle,
  }
  const lw = wasm.createLod(geometry)
  const lt = dg.tsKernels.createLod(geometry)
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
  for (const zoom of [2, 5]) {
    const a = lw.level(zoom)
    const t = lt.level(zoom)
    check(a.nodes.length > 0, `LOD z${zoom} keeps nodes`)
    check(same(a.nodes, t.nodes), `LOD z${zoom} nodes match`)
    check(same(a.segEdge, t.segEdge), `LOD z${zoom} segments match`)
    check(same(a.segP0, t.segP0) && same(a.segP1, t.segP1), `LOD z${zoom} path points match`)
  }
  lw.dispose()
  lt.dispose()

  if (failures.length) {
    console.error(failures.map((f) => `    failed: ${f}`).join('\n'))
    process.exit(1)
  }
JS

WASM_MAGIC="Buffer.from([0x00, 0x61, 0x73, 0x6d])"

{
  cat <<'JS'
import * as dg from 'skeinmap'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
{
JS
  cat checks.txt
  cat <<JS
  for (const s of ['skeinmap/leaflet', 'skeinmap/maplibre', 'skeinmap/react', 'skeinmap/lod-worker']) {
    if (!import.meta.resolve(s).endsWith('.js')) {
      console.error('    bad ESM resolution for ' + s)
      process.exit(1)
    }
  }
  const wasmFile = fileURLToPath(import.meta.resolve('skeinmap/wasm'))
  if (!readFileSync(wasmFile).subarray(0, 4).equals($WASM_MAGIC)) {
    console.error('    skeinmap/wasm is not a WebAssembly binary')
    process.exit(1)
  }
  console.log('    ok: ESM')
}
JS
} > esm-check.mjs

{
  cat <<'JS'
const dg = require('skeinmap')
const fs = require('node:fs')
async function main() {
JS
  cat checks.txt
  cat <<JS
  for (const s of ['skeinmap/leaflet', 'skeinmap/maplibre', 'skeinmap/react', 'skeinmap/lod-worker']) {
    if (!require.resolve(s).endsWith('.cjs')) {
      console.error('    bad CJS resolution for ' + s)
      process.exit(1)
    }
  }
  if (!fs.readFileSync(require.resolve('skeinmap/style.css'), 'utf8').includes('skeinmap')) {
    console.error('    skeinmap/style.css looks wrong')
    process.exit(1)
  }
  if (!fs.readFileSync(require.resolve('skeinmap/wasm')).subarray(0, 4).equals($WASM_MAGIC)) {
    console.error('    skeinmap/wasm is not a WebAssembly binary')
    process.exit(1)
  }
  console.log('    ok: CJS')
}
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
JS
} > cjs-check.cjs

echo "==> Node ESM"
set +e
node esm-check.mjs
record "Node ESM: import, initWasm() from file URL, WASM = TS kernels, subpaths" $?
set -e

echo "==> Node CommonJS"
set +e
node cjs-check.cjs
record "Node CJS: require, initWasm() from disk, WASM = TS kernels, subpaths, style.css" $?
set -e

echo "==> Vite build"
mkdir -p web
cat > web/index.html <<'HTML'
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>smoke</title></head>
  <body>
    <script type="module" src="./main.js"></script>
  </body>
</html>
HTML
cat > web/main.js <<'JS'
import 'skeinmap/style.css'
import { initWasm, kernels, SceneBuilder } from 'skeinmap'

const b = new SceneBuilder()
b.edge(b.node(0, 0), b.node(1, 1))
initWasm().then((ok) => {
  document.body.dataset.kernels = ok ? kernels().name : 'ts'
  document.body.dataset.nodes = String(b.build().nodeCount)
})
JS
set +e
(
  set -e
  npx --no-install vite build web --outDir "$APP/web-dist" --emptyOutDir --logLevel warn
  WASM_ASSETS="$(find "$APP/web-dist" -name '*.wasm' | wc -l | tr -d ' ')"
  echo "    emitted .wasm assets: $WASM_ASSETS"
  [ "$WASM_ASSETS" -ge 1 ]
  # The emitted bundle must reference the hashed .wasm file it ships.
  WASM_BASE="$(basename "$(find "$APP/web-dist" -name '*.wasm' | head -n 1)")"
  grep -rqF "$WASM_BASE" "$APP/web-dist" --include='*.js'
)
record "Vite build: bundles skeinmap and emits the .wasm asset" $?
set -e

echo
echo "Smoke test summary ($TARBALL_NAME)"
for r in "${RESULTS[@]}"; do echo "  $r"; done
if [ "$FAILED" -ne 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
