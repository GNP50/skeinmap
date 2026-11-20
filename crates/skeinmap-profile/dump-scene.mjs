// Writes the benchmark scenes of bench/run.mjs as raw little-endian arrays, so the native
// spanscope harness (src/main.rs) profiles the kernels on exactly the same inputs.
//
//   npm run build && node crates/skeinmap-profile/dump-scene.mjs [--sizes 100000,1000000]
//
// Output: target/profile-data/<n>/<name>.<f64|u32|u8> plus meta.json.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
if (!existsSync(`${root}dist/index.js`)) {
  console.error('dist/ is missing: run "npm run build" first')
  process.exit(1)
}
const { SceneBuilder, tsKernels } = await import(`${root}dist/index.js`)

const args = process.argv.slice(2)
const i = args.indexOf('--sizes')
const SIZES = (i >= 0 ? args[i + 1] : '100000,1000000').split(',').map(Number)

// Same generator as bench/run.mjs.
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeScene(n, seed = 42) {
  const rnd = mulberry32(seed)
  const centres = Array.from({ length: 60 }, () => [-10 + rnd() * 40, 36 + rnd() * 24])
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const b = new SceneBuilder({ nodes: n, edges: n, pathPoints: Math.ceil(n / 8) * 12 })
  for (let i = 0; i < n; i++) {
    const [cx, cy] = centres[i % centres.length]
    const r = Math.sqrt(rnd()) * 1.5
    const a = rnd() * Math.PI * 2
    xs[i] = cx + Math.cos(a) * r
    ys[i] = cy + Math.sin(a) * r * 0.7
    b.node(xs[i], ys[i], i % 5 === 0 ? 1 : 0)
  }
  const path = []
  for (let e = 0; e < n; e++) {
    const to = rnd() < 0.9 ? (e + 60) % n : Math.floor(rnd() * n)
    let p = null
    if (e % 8 === 0) {
      path.length = 0
      const wiggle = rnd() * 0.05
      for (let k = 0; k < 12; k++) {
        const t = k / 11
        const off = Math.sin(t * 9 + e) * wiggle
        path.push(xs[e] + (xs[to] - xs[e]) * t + off, ys[e] + (ys[to] - ys[e]) * t + off)
      }
      p = path
    }
    b.edge(e, to, e % 3, p)
  }
  return b.build()
}

for (const n of SIZES) {
  const scene = makeScene(n)
  const pn = scene.pathX.length
  const ux = new Float64Array(n)
  const uy = new Float64Array(n)
  const upx = new Float64Array(pn)
  const upy = new Float64Array(pn)
  tsKernels.projectMercator(scene.nodeX, scene.nodeY, ux, uy, n)
  tsKernels.projectMercator(scene.pathX, scene.pathY, upx, upy, pn)
  // Grid inputs as in bench/run.mjs: zoom 6, a 1920×1080 view ± half a screen.
  const kz = 2 ** 6
  const px = new Float64Array(n)
  const py = new Float64Array(n)
  let cx = 0
  let cy = 0
  for (let i = 0; i < n; i++) {
    px[i] = ux[i] * kz
    py[i] = uy[i] * kz
    cx += px[i]
    cy += py[i]
  }
  cx /= n
  cy /= n
  const dir = `${root}target/profile-data/${n}`
  mkdirSync(dir, { recursive: true })
  const put = (name, arr, ext) =>
    writeFileSync(`${dir}/${name}.${ext}`, new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength))
  put('node_x', scene.nodeX, 'f64')
  put('node_y', scene.nodeY, 'f64')
  put('unit_x', ux, 'f64')
  put('unit_y', uy, 'f64')
  put('node_style', scene.nodeStyle.subarray(0, n), 'u8')
  put('edge_from', scene.edgeFrom.subarray(0, scene.edgeCount), 'u32')
  put('edge_to', scene.edgeTo.subarray(0, scene.edgeCount), 'u32')
  put('edge_style', scene.edgeStyle.subarray(0, scene.edgeCount), 'u8')
  put('path_start', scene.edgePathStart.subarray(0, scene.edgeCount), 'u32')
  put('path_end', scene.edgePathEnd.subarray(0, scene.edgeCount), 'u32')
  put('unit_px', upx, 'f64')
  put('unit_py', upy, 'f64')
  put('proj_x', px, 'f64')
  put('proj_y', py, 'f64')
  const win = { x0: cx - 1920, y0: cy - 1080, x1: cx + 1920, y1: cy + 1080 }
  writeFileSync(`${dir}/meta.json`, JSON.stringify({ nodes: n, edges: scene.edgeCount, pathPoints: pn, win }, null, 2))
  console.log(`wrote ${dir} (${n} nodes, ${scene.edgeCount} edges, ${pn} path points)`)
}
