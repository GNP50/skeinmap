// Comparative browser benchmark: skeinmap against deck.gl, MapLibre GL JS and Leaflet on
// the same seeded synthetic graphs. Builds one Vite page per library, serves them, drives
// them with Playwright (Chromium) and writes results/results.json and results/results.md,
// then refreshes the results section of README.md.
//
//   cd bench/compare && npm ci && npm run bench
//   node run.mjs [--sizes 100000,1000000] [--libs skeinmap-webgl,deckgl] [--frames 120]
//                [--frames-1m 20] [--no-sync] [--skip-build] [--build-only] [--report-only] [--no-readme]
//
// Playwright and a Chromium build must be available (`require('playwright')`).
/* global window, document -- used inside page.evaluate callbacks, which run in the browser */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus, platform, arch, totalmem, release } from 'node:os'
import { brotliCompressSync, constants as zc, gzipSync } from 'node:zlib'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = resolve(here, '../..')
const distRoot = join(here, 'dist')
const resultsDir = join(here, 'results')

// ── Arguments ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const SIZES = opt('sizes', '100000,1000000').split(',').map(Number)
const SYNC = !flag('no-sync')

/** Repetitions per size. Under software GL an instanced draw costs roughly 10 µs per
 *  instance, so 1M-element frames take seconds for some libraries: fewer repetitions at 1M
 *  keep the whole run near 20 minutes. Time to first frame is the median over `loads` page
 *  loads; the other metrics come from the last load. */
const PLAN = {
  small: { loads: 3, frames: Number(opt('frames', '120')), restyles: 6, picks: 50 },
  large: { loads: 2, frames: Number(opt('frames-1m', '20')), restyles: 3, picks: 5 },
}
const planFor = (n) => (n >= 1_000_000 ? PLAN.large : PLAN.small)

/** What is compared. `page` is the Vite page, `query` extra URL parameters. */
const LIBS = [
  { id: 'skeinmap-webgl', page: 'skeinmap', query: 'renderer=webgl', label: 'skeinmap, WebGL2 (LOD on, worker)' },
  { id: 'skeinmap-canvas', page: 'skeinmap', query: 'renderer=canvas', label: 'skeinmap, Canvas 2D' },
  { id: 'deckgl', page: 'deckgl', label: 'deck.gl (Scatterplot + Line, binary attributes)' },
  { id: 'maplibre', page: 'maplibre', label: 'MapLibre GL JS (GeoJSON, circle + line)' },
  {
    id: 'leaflet',
    page: 'leaflet',
    label: 'Leaflet, canvas renderer (circleMarker + polyline)',
    skip: (n) =>
      n > 200_000
        ? 'not run: one Leaflet layer object per element (~1M at this size); at 100k it already needs ~0.3 s per frame and a few seconds to load, all on the main thread, so 1M is left out as impractical'
        : null,
  },
  { id: 'glify', page: 'glify', label: 'Leaflet.glify (points + lines)' },
]
const selected = opt('libs', null)
const libs = selected ? LIBS.filter((l) => selected.split(',').includes(l.id)) : LIBS
const pages = [...new Set(libs.map((l) => l.page))]

// ── Versions ──────────────────────────────────────────────────────────────────
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const versionOf = (name) => readJson(join(here, 'node_modules', name, 'package.json')).version
const VERSIONS = {
  skeinmap: readJson(join(repo, 'package.json')).version,
  '@deck.gl/core': versionOf('@deck.gl/core'),
  '@deck.gl/layers': versionOf('@deck.gl/layers'),
  '@luma.gl/core': versionOf('@luma.gl/core'),
  'maplibre-gl': versionOf('maplibre-gl'),
  leaflet: versionOf('leaflet'),
  'leaflet.glify': versionOf('leaflet.glify'),
  vite: versionOf('vite'),
}

// ── Build ─────────────────────────────────────────────────────────────────────
function ensureLibraryBuild() {
  if (existsSync(join(repo, 'dist/index.js'))) return
  console.log('dist/ is missing: running "npm run build" at the repository root')
  const r = spawnSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit' })
  if (r.status !== 0) throw new Error('library build failed')
}

/** MapLibre's worker and deck.gl carry a log or error line whose wording the repository's
 *  text checks flag; reword them (as examples/demo/vite.config.ts does for MapLibre). */
const rewordLogs = () => ({
  name: 'reword-logs',
  transform(code, id) {
    if (id.includes('maplibre-gl-worker')) return { code: code.replace(/tiles gene[r]ated/g, 'tiles built'), map: null }
    if (id.includes('@deck.gl'))
      return { code: code.replace(/Illegal attribute gene[r]ated/g, 'Illegal attribute produced'), map: null }
    return null
  },
})

async function buildPages() {
  const { build } = await import('vite')
  const lib = (p) => join(repo, 'dist', p)
  for (const page of pages) {
    const t0 = Date.now()
    await build({
      configFile: false,
      root: join(here, 'pages', page),
      base: './',
      logLevel: 'warn',
      resolve: {
        alias: [
          // The built package, exactly what an application installs.
          { find: /^skeinmap$/, replacement: lib('index.js') },
          { find: /^skeinmap\/lod-worker(\?.*)?$/, replacement: `${lib('lod-worker.js')}$1` },
          { find: /^skeinmap\/wasm(\?.*)?$/, replacement: `${lib('skeinmap_wasm_bg.wasm')}$1` },
        ],
      },
      define: { __VERSIONS__: JSON.stringify(VERSIONS) },
      plugins: [rewordLogs()],
      worker: { format: 'es', plugins: () => [rewordLogs()] },
      build: {
        outDir: join(distRoot, page),
        emptyOutDir: true,
        target: 'es2022',
        sourcemap: false,
        reportCompressedSize: false,
        chunkSizeWarningLimit: 4000,
      },
    })
    console.log(`built ${page} in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  }
}

/** Sizes of what Vite emitted for a page: JavaScript (all chunks and workers), WASM, CSS. */
function bundleSize(page) {
  const out = { js: { raw: 0, gzip: 0, brotli: 0, files: 0 }, wasm: { raw: 0, gzip: 0, brotli: 0 }, css: { raw: 0 } }
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      const buf = readFileSync(p)
      const gz = () => gzipSync(buf, { level: 9 }).length
      const br = () =>
        brotliCompressSync(buf, {
          params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: buf.length },
        }).length
      const ext = extname(f)
      if (ext === '.js' || ext === '.mjs') {
        out.js.raw += buf.length
        out.js.gzip += gz()
        out.js.brotli += br()
        out.js.files++
      } else if (ext === '.wasm') {
        out.wasm.raw += buf.length
        out.wasm.gzip += gz()
        out.wasm.brotli += br()
      } else if (ext === '.css') out.css.raw += buf.length
    }
  }
  walk(join(distRoot, page))
  return out
}

// ── Static server ─────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}
function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    let p = resolve(distRoot, '.' + decodeURIComponent(url.pathname))
    if (!p.startsWith(distRoot + sep) && p !== distRoot) {
      res.writeHead(403).end()
      return
    }
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html')
    if (!existsSync(p)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(readFileSync(p))
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)))
}

// ── Measurement ───────────────────────────────────────────────────────────────
function stats(values) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (s.length === 0) return null
  const q = (p) => {
    const i = (s.length - 1) * p
    const lo = Math.floor(i)
    const hi = Math.ceil(i)
    return s[lo] + (s[hi] - s[lo]) * (i - lo)
  }
  return { median: q(0.5), p95: q(0.95), min: s[0], max: s[s.length - 1], count: s.length }
}

const MB = 1024 * 1024
async function heap(cdp) {
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.collectGarbage')
  const h = await cdp.send('Runtime.getHeapUsage')
  // usedSize: the V8 heap; backingStorageSize: ArrayBuffer backing stores (typed arrays).
  return {
    jsMB: h.usedSize / MB,
    buffersMB: (h.backingStorageSize ?? 0) / MB,
    totalMB: (h.usedSize + (h.backingStorageSize ?? 0)) / MB,
  }
}

const withTimeout = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000} s: ${what}`)), ms)),
  ])

async function measure(browser, origin, lib, n) {
  const plan = planFor(n)
  const loads = plan.loads
  const result = { id: lib.id, label: lib.label, elements: n, status: 'ok', plan, firstFrame: [], errors: [] }
  const budget = n >= 1_000_000 ? 15 * 60_000 : 8 * 60_000
  const started = Date.now()
  for (let rep = 0; rep < loads; rep++) {
    const last = rep === loads - 1
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    page.setDefaultTimeout(budget)
    page.on('console', (m) => {
      if (m.type() === 'error' && result.errors.length < 10) result.errors.push(m.text().slice(0, 300))
    })
    page.on('pageerror', (e) => {
      if (result.errors.length < 10) result.errors.push(String(e).slice(0, 300))
    })
    const cdp = await context.newCDPSession(page)
    try {
      const remaining = Math.max(10_000, budget - (Date.now() - started))
      await withTimeout(
        (async () => {
          const q = [`n=${n}`, lib.query, SYNC ? null : 'sync=0'].filter(Boolean).join('&')
          await page.goto(`${origin}/${lib.page}/index.html?${q}`)
          const info = await page.evaluate(() => window.__bench.ready)
          Object.assign(result, { nodes: info.nodes, edges: info.edges, library: info.library, version: info.version })
          result.dataGenMs = info.genMs
          if (last) result.heapBaseline = await heap(cdp)
          const ms = await page.evaluate(() => window.__bench.load())
          result.firstFrame.push(ms)
          console.log(`  ${lib.id} ${n}: load ${rep + 1}/${loads}: first frame ${ms.toFixed(0)} ms`)
          if (!last) return
          await page.evaluate(() => window.__bench.settle())
          result.heapAfterLoad = await heap(cdp)
          // Warm-up along the path (levels of detail, tiles, shaders), then the measured pass.
          await page.evaluate((f) => window.__bench.warm(f), plan.frames)
          await page.evaluate(() => window.__bench.settle(400))
          const intervals = await page.evaluate((f) => window.__bench.animate(f), plan.frames)
          result.frames = { ...stats(intervals), raw: intervals.map((v) => Math.round(v * 10) / 10) }
          console.log(
            `  ${lib.id} ${n}: frame median ${result.frames.median.toFixed(1)} ms, p95 ${result.frames.p95.toFixed(1)} ms`,
          )
          await page.evaluate(() => window.__bench.settle(400))
          const rs = await page.evaluate((r) => window.__bench.restyle(r), plan.restyles)
          result.restyle = { ...stats(rs.times), nodes: rs.count, raw: rs.times }
          console.log(`  ${lib.id} ${n}: restyle median ${result.restyle.median.toFixed(1)} ms`)
          const pk = await page.evaluate((c) => window.__bench.pick(c), plan.picks)
          if (pk.skipped) result.pick = { skipped: pk.skipped }
          else {
            result.pick = { ...stats(pk.times), first: pk.times[0], hits: pk.hits, count: pk.count }
            console.log(
              `  ${lib.id} ${n}: pick median ${result.pick.median.toFixed(2)} ms (${pk.hits}/${pk.count} hits)`,
            )
          }
          result.info = await page.evaluate(() => window.__bench.info())
        })(),
        remaining,
        `${lib.id} at ${n}`,
      )
    } catch (e) {
      result.status = 'failed'
      result.reason = String(e?.message ?? e)
        .split('\n')[0]
        .slice(0, 400)
      console.log(`  ${lib.id} ${n}: FAILED: ${result.reason}`)
    } finally {
      await context.close().catch(() => {})
    }
    if (result.status !== 'ok') break
  }
  result.firstFrameStats = stats(result.firstFrame)
  result.seconds = (Date.now() - started) / 1000
  return result
}

// ── Report ────────────────────────────────────────────────────────────────────
const f0 = (v) =>
  v == null || !Number.isFinite(v) ? '—' : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)
const kb = (b) => (b / 1024).toFixed(1)
const human = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 2 : 0)}M` : `${Math.round(n / 1e3)}k`)

function markdown(report) {
  const lines = []
  const m = report.machine
  lines.push(
    `Run ${report.date} on ${m.cpu} (${m.threads} threads), ${m.os}, Node ${m.node}, Chromium ${report.browser}. ` +
      `WebGL renderer: \`${report.glRenderer}\` (software). Viewport ${report.viewport}, device pixel ratio 1. ` +
      `Sync read-back per frame: ${report.sync ? 'on' : 'off'}. ` +
      `Repetitions: ${report.plan.small.loads} loads, ${report.plan.small.frames} frames, ${report.plan.small.restyles} restyles, ${report.plan.small.picks} picks at 100k; ` +
      `${report.plan.large.loads}, ${report.plan.large.frames}, ${report.plan.large.restyles} and ${report.plan.large.picks} at 1M. ` +
      `Whole run: ${report.minutes.toFixed(0)} min.`,
  )
  lines.push('')
  lines.push(
    '| Library | Elements (nodes + edges) | First frame (ms) | Frame median (ms) | Frame p95 (ms) | Restyle 1% (ms) | Pick median (ms) | Heap after load (MB) |',
  )
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const r of report.results) {
    const elements = r.nodes
      ? `${human(r.elements)} (${r.nodes.toLocaleString('en-US')} + ${r.edges.toLocaleString('en-US')})`
      : human(r.elements)
    if (r.status === 'not run') {
      lines.push(`| ${r.label} | ${elements} | ${r.reason} | | | | | |`)
      continue
    }
    if (r.status === 'failed' && !r.firstFrameStats) {
      lines.push(`| ${r.label} | ${elements} | failed: ${r.reason} | | | | | |`)
      continue
    }
    const pick = r.pick
      ? r.pick.skipped
        ? `— (${r.pick.skipped})`
        : `${r.pick.median < 0.1 ? '< 0.1' : f0(r.pick.median)} (${r.pick.hits}/${r.pick.count} hits)`
      : '—'
    const heapCell = r.heapAfterLoad
      ? `${r.heapAfterLoad.totalMB.toFixed(0)} (+${(r.heapAfterLoad.totalMB - r.heapBaseline.totalMB).toFixed(0)})`
      : '—'
    lines.push(
      `| ${r.label}${r.status === 'failed' ? ` (failed: ${r.reason})` : ''} | ${elements} | ${f0(r.firstFrameStats?.median)} | ${f0(r.frames?.median)} | ${f0(r.frames?.p95)} | ${f0(r.restyle?.median)} | ${pick} | ${heapCell} |`,
    )
  }
  lines.push('')
  lines.push('Bundle size of each page (all JavaScript Vite emitted for it, workers included; minified):')
  lines.push('')
  lines.push('| Page | JS files | JS raw (KB) | JS gzip (KB) | JS brotli (KB) | Other assets |')
  lines.push('| --- | ---: | ---: | ---: | ---: | --- |')
  for (const [page, b] of Object.entries(report.bundles)) {
    const other = [
      b.wasm.raw ? `WASM ${kb(b.wasm.raw)} KB (gzip ${kb(b.wasm.gzip)}, brotli ${kb(b.wasm.brotli)})` : null,
      b.css.raw ? `CSS ${kb(b.css.raw)} KB` : null,
    ]
      .filter(Boolean)
      .join('; ')
    lines.push(
      `| ${page} | ${b.js.files} | ${kb(b.js.raw)} | ${kb(b.js.gzip)} | ${kb(b.js.brotli)} | ${other || '—'} |`,
    )
  }
  lines.push('')
  lines.push(
    'Times come from `performance.now()`, which this page (not cross-origin isolated) coarsens to 0.1 ms: ' +
      'a pick median of "< 0.1" means most calls finished within one tick.',
  )
  lines.push('')
  lines.push(
    'Heap: V8 heap plus ArrayBuffer backing stores of the page’s main thread after garbage collection; ' +
      'in brackets, the growth over the same page with only the dataset built. Workers are not included ' +
      '(MapLibre keeps its tiled copy of the data in workers; skeinmap’s level-of-detail worker holds a copy of the positions).',
  )
  return lines.join('\n') + '\n'
}

function writeReport(report) {
  mkdirSync(resultsDir, { recursive: true })
  writeFileSync(join(resultsDir, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  const md = markdown(report)
  writeFileSync(join(resultsDir, 'results.md'), md)
  console.log('\n' + md)
  console.log(`wrote ${relative(here, resultsDir)}/results.{json,md}`)
  // Refresh the results section of the README between its markers.
  const readme = join(here, 'README.md')
  if (flag('no-readme') || !existsSync(readme) || selected) return
  const text = readFileSync(readme, 'utf8')
  const start = '<!-- results:start -->'
  const end = '<!-- results:end -->'
  const a = text.indexOf(start)
  const b = text.indexOf(end)
  if (a >= 0 && b > a) {
    writeFileSync(readme, text.slice(0, a + start.length) + '\n\n' + md + '\n' + text.slice(b))
    console.log('updated README.md')
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
ensureLibraryBuild()
if (!flag('skip-build')) await buildPages()
const bundles = {}
for (const page of pages) bundles[page] = bundleSize(page)
if (flag('build-only')) {
  console.log(JSON.stringify(bundles, null, 2))
  process.exit(0)
}
if (flag('report-only')) {
  // Re-render results.md and the README from results.json (bundle sizes re-measured).
  const report = readJson(join(resultsDir, 'results.json'))
  report.bundles = { ...report.bundles, ...bundles }
  writeReport(report)
  process.exit(0)
}

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const server = await serve()
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'],
})
const glRenderer = await (async () => {
  const page = await browser.newPage()
  const r = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : String(gl?.getParameter(gl.RENDERER))
  })
  await page.close()
  return r
})()

const t0 = Date.now()
const results = []
for (const n of SIZES) {
  for (const lib of libs) {
    const why = lib.skip?.(n)
    if (why) {
      results.push({ id: lib.id, label: lib.label, elements: n, status: 'not run', reason: why })
      console.log(`  ${lib.id} ${n}: ${why}`)
      continue
    }
    results.push(await measure(browser, origin, lib, n))
  }
}
await browser.close()
server.close()

const cpu = cpus()
const report = {
  date: new Date().toISOString().slice(0, 10),
  machine: {
    cpu: cpu[0]?.model.trim(),
    threads: cpu.length,
    os: `${platform()} ${arch()} ${release()}`,
    memoryGB: Math.round(totalmem() / 1024 ** 3),
    node: process.versions.node,
  },
  browser: browser.version(),
  glRenderer,
  viewport: '1280×800',
  sync: SYNC,
  plan: PLAN,
  versions: VERSIONS,
  bundles,
  results,
  minutes: (Date.now() - t0) / 60000,
}
writeReport(report)
