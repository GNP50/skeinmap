// Reproducible benchmarks of the hot paths: TypeScript kernels vs WebAssembly kernels,
// on seeded synthetic data at 10k, 100k and 1M nodes (plus as many edges, and polyline
// paths). Runs against the built package in dist/ — what users get.
//
//   npm run build && node bench/run.mjs [--sizes 10000,100000] [--time 1500]
//
// Writes bench/results/results.json and bench/results/results.md.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { cpus, platform, arch, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
if (!existsSync(`${root}dist/index.js`)) {
  console.error('dist/ is missing: run "npm run build" first')
  process.exit(1)
}
const lib = await import(`${root}dist/index.js`)
const { SceneBuilder, initWasm, kernels, tsKernels, setKernelPreference } = lib

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const SIZES = arg('sizes', '10000,100000,1000000').split(',').map(Number)
const TIME_MS = Number(arg('time', '1500'))

if (!(await initWasm())) {
  console.error('could not load the WebAssembly module')
  process.exit(1)
}
setKernelPreference('auto')
const wasm = kernels()
if (wasm.name !== 'wasm') throw new Error('expected the WASM kernels to be active')

// ── Synthetic data ────────────────────────────────────────────────────────────

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

/** n nodes clustered around 60 centres over a continent-sized box; n edges (mostly
 *  between nearby nodes of the same cluster, some random); every 8th edge carries a
 *  12-point wiggly polyline. */
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

// ── Timing ────────────────────────────────────────────────────────────────────

function measure(fn, setup) {
  // Warm up (JIT, WASM tier-up), then run until TIME_MS or 30 runs, at least 5.
  for (let i = 0; i < 2; i++) {
    const s = setup?.()
    fn(s)
  }
  const times = []
  const start = performance.now()
  while ((performance.now() - start < TIME_MS || times.length < 5) && times.length < 30) {
    const s = setup?.()
    const t0 = performance.now()
    fn(s)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return { median: times[Math.floor(times.length / 2)], min: times[0], runs: times.length }
}

// ── Cases ─────────────────────────────────────────────────────────────────────

const results = []
const record = (size, name, impl, r) => {
  results.push({ size, case: name, impl, ...r })
  console.log(
    `${String(size).padStart(8)}  ${name.padEnd(38)} ${impl.padEnd(4)}  median ${r.median.toFixed(2).padStart(8)} ms  (min ${r.min.toFixed(2)}, ${r.runs} runs)`,
  )
}

for (const n of SIZES) {
  const tBuild0 = performance.now()
  const scene = makeScene(n)
  const buildMs = performance.now() - tBuild0
  console.log(
    `\nscene: ${n} nodes, ${scene.edgeCount} edges, ${scene.pathX.length} path points (built in ${buildMs.toFixed(0)} ms)`,
  )

  const ux = new Float64Array(n)
  const uy = new Float64Array(n)
  const pn = scene.pathX.length
  const upx = new Float64Array(pn)
  const upy = new Float64Array(pn)
  tsKernels.projectMercator(scene.nodeX, scene.nodeY, ux, uy, n)
  tsKernels.projectMercator(scene.pathX, scene.pathY, upx, upy, pn)

  // SceneBuilder (TypeScript only): nodes + edges, no paths.
  record(
    n,
    'SceneBuilder (n nodes + n edges)',
    'ts',
    measure(() => {
      const b = new SceneBuilder({ nodes: n, edges: n })
      for (let i = 0; i < n; i++) b.node(scene.nodeX[i], scene.nodeY[i], scene.nodeStyle[i])
      for (let e = 0; e < n; e++) b.edge(scene.edgeFrom[e], scene.edgeTo[e], scene.edgeStyle[e])
      b.build()
    }),
  )

  for (const k of [tsKernels, wasm]) {
    const ox = new Float64Array(n)
    const oy = new Float64Array(n)
    record(
      n,
      'project mercator (nodes)',
      k.name,
      measure(() => k.projectMercator(scene.nodeX, scene.nodeY, ox, oy, n)),
    )
  }

  const geometry = {
    nodeCount: n,
    unitX: ux,
    unitY: uy,
    nodeStyle: scene.nodeStyle,
    edgeCount: scene.edgeCount,
    edgeFrom: scene.edgeFrom,
    edgeTo: scene.edgeTo,
    edgeStyle: scene.edgeStyle,
    edgePathStart: scene.edgePathStart,
    edgePathEnd: scene.edgePathEnd,
    unitPX: upx,
    unitPY: upy,
  }
  for (const k of [tsKernels, wasm]) {
    const lod = k.createLod(geometry)
    for (const z of [4, 8])
      record(
        n,
        `LOD level z${z}`,
        k.name,
        measure(() => lod.level(z)),
      )
    lod.dispose()
    record(
      n,
      'LOD setup (copy geometry)',
      k.name,
      measure(() => k.createLod(geometry).dispose()),
    )
  }

  // Hit-test grid over a 1920×1080 view ± half a screen, at a zoom where most of the
  // scene is inside the window (the worst case for a build).
  const zoom = 6
  const kz = 2 ** zoom
  const px = new Float64Array(n)
  const py = new Float64Array(n)
  let cxs = 0
  let cys = 0
  for (let i = 0; i < n; i++) {
    px[i] = ux[i] * kz
    py[i] = uy[i] * kz
    cxs += px[i]
    cys += py[i]
  }
  cxs /= n
  cys /= n
  const win = { x0: cxs - 1920, y0: cys - 1080, x1: cxs + 1920, y1: cys + 1080 }
  const topology = { nodeCount: n, edgeCount: scene.edgeCount, edgeFrom: scene.edgeFrom, edgeTo: scene.edgeTo }
  let inside = 0
  for (const k of [tsKernels, wasm]) {
    const builder = k.createGridBuilder(topology)
    record(
      n,
      'grid build (picking index)',
      k.name,
      measure(() => {
        inside = builder.build({ projX: px, projY: py }, win, 32).nodeItems.length
      }),
    )
    builder.dispose()
  }
  console.log(`          (grid window holds ${inside} of ${n} nodes)`)

  for (const k of [tsKernels, wasm]) {
    const keep = new Uint8Array(pn)
    record(
      n,
      'Douglas–Peucker (paths)',
      k.name,
      measure(() =>
        k.simplifyPaths(upx, upy, scene.edgePathStart, scene.edgePathEnd, scene.edgeCount, 0.5 / 2 ** 8, keep),
      ),
    )
  }
  // The same work through a simplifier created once (the points cross into WASM once),
  // as the layer does on each zoom change; same tolerance as above, for comparison.
  for (const k of [tsKernels, wasm]) {
    const keep = new Uint8Array(pn)
    const simplifier = k.createSimplifier(upx, upy, scene.edgePathStart, scene.edgePathEnd, scene.edgeCount)
    record(
      n,
      'Douglas–Peucker (persistent, per zoom)',
      k.name,
      measure(() => simplifier.simplify(0.5 / 2 ** 8, keep)),
    )
    simplifier.dispose()
    record(
      n,
      'Douglas–Peucker setup (persistent)',
      k.name,
      measure(() => k.createSimplifier(upx, upy, scene.edgePathStart, scene.edgePathEnd, scene.edgeCount).dispose()),
    )
  }

  // Grid clustering (60 px cells) through a clusterer created once, as a cluster index
  // does per zoom; plus the one-time copy of the positions.
  let clusters = 0
  for (const k of [tsKernels, wasm]) {
    const clusterer = k.createClusterer(ux, uy, scene.nodeStyle, n)
    record(
      n,
      'cluster level z6',
      k.name,
      measure(() => {
        clusters = clusterer.level(6).count.length
      }),
    )
    clusterer.dispose()
    record(
      n,
      'cluster setup (copy positions)',
      k.name,
      measure(() => k.createClusterer(ux, uy, scene.nodeStyle, n).dispose()),
    )
  }
  console.log(`          (${clusters} clusters at z6)`)
}

// ── Report ────────────────────────────────────────────────────────────────────

const env = {
  date: new Date().toISOString(),
  node: process.version,
  v8: process.versions.v8,
  cpu: cpus()[0]?.model ?? 'unknown',
  cores: cpus().length,
  memoryGb: Math.round(totalmem() / 2 ** 30),
  platform: `${platform()} ${arch()}`,
  timeBudgetMs: TIME_MS,
}
const outDir = `${root}bench/results`
mkdirSync(outDir, { recursive: true })
writeFileSync(`${outDir}/results.json`, JSON.stringify({ env, results }, null, 2))

const cases = [...new Set(results.map((r) => r.case))]
let md = `Measured ${env.date.slice(0, 10)} on ${env.cpu} (${env.cores} threads), ${env.platform}, Node ${env.node}. Median of up to 30 runs, milliseconds; lower is better.\n\n`
md += `| Case | Size | TypeScript | WebAssembly | Speed-up |\n|---|---:|---:|---:|---:|\n`
for (const c of cases) {
  for (const n of SIZES) {
    const t = results.find((r) => r.case === c && r.size === n && r.impl === 'ts')
    const w = results.find((r) => r.case === c && r.size === n && r.impl === 'wasm')
    if (!t) continue
    const fmt = (x) => (x < 10 ? x.toFixed(2) : x.toFixed(1))
    md += `| ${c} | ${n.toLocaleString('en-US')} | ${fmt(t.median)} | ${w ? fmt(w.median) : '—'} | ${w && !c.includes('setup') ? `${(t.median / w.median).toFixed(2)}×` : '—'} |\n`
  }
}
writeFileSync(`${outDir}/results.md`, md)
console.log(`\nwrote bench/results/results.json and bench/results/results.md`)
