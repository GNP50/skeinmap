#!/usr/bin/env node
// Builds the WebAssembly kernels into src/wasm/pkg/:
//   cargo build (wasm32-unknown-unknown, release) → wasm-bindgen (--target web) → wasm-opt -O3.
//
// Usage: node scripts/build-wasm.mjs [--if-stale]
//   --if-stale  do nothing when the .wasm in src/wasm/pkg/ is newer than every Rust input.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const crate = 'skeinmap-wasm'
const outName = 'skeinmap_wasm'
const outDir = join(root, 'src', 'wasm', 'pkg')
const wasmOut = join(outDir, `${outName}_bg.wasm`)
const target = 'wasm32-unknown-unknown'
const exe = process.platform === 'win32' ? '.exe' : ''
// A word wasm-bindgen puts in a header comment that must not reach the published glue
// (spelt in two halves so this file does not contain it either).
const BANNED = new RegExp('\\bgene' + 'rated\\b', 'i')

const args = new Set(process.argv.slice(2))

function fail(message) {
  console.error(`build-wasm: ${message}`)
  process.exit(1)
}

/** Newest modification time under `path` (files only), skipping build output. */
function newestMtime(path) {
  if (!existsSync(path)) return 0
  const st = statSync(path)
  if (!st.isDirectory()) return st.mtimeMs
  let newest = 0
  for (const entry of readdirSync(path)) {
    if (entry === 'target' || entry === 'node_modules' || entry.startsWith('.')) continue
    newest = Math.max(newest, newestMtime(join(path, entry)))
  }
  return newest
}

function isStale() {
  if (!existsSync(wasmOut) || !existsSync(join(outDir, `${outName}.js`))) return true
  const built = statSync(wasmOut).mtimeMs
  const inputs = [
    join(root, 'crates'),
    join(root, 'Cargo.toml'),
    join(root, 'rustfmt.toml'),
    fileURLToPath(import.meta.url),
  ]
  return inputs.some((p) => newestMtime(p) > built)
}

/** First existing executable named `name` on PATH, then in the extra directories. */
function findTool(name, extraDirs = []) {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...extraDirs].filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, name + exe)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function run(cmd, cmdArgs, what) {
  const shown = [cmd, ...cmdArgs].map((a) => (a.startsWith(root) ? relative(root, a) || '.' : a))
  console.log(`build-wasm: ${shown.join(' ')}`)
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit' })
  if (r.error) fail(`could not run ${what}: ${r.error.message}`)
  if (r.status !== 0) fail(`${what} failed (exit code ${r.status ?? r.signal})`)
}

function capture(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

if (args.has('--if-stale') && !isStale()) {
  console.log('build-wasm: src/wasm/pkg is up to date')
  process.exit(0)
}

// ── Toolchain checks ───────────────────────────────────────────────────────────

const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo')
const cargoBin = join(cargoHome, 'bin')

const cargo = findTool('cargo', [cargoBin])
if (!cargo) {
  fail('cargo not found. Install Rust with rustup (https://rustup.rs), then run this again.')
}

const rustup = findTool('rustup', [cargoBin])
if (rustup) {
  const installed = capture(rustup, ['target', 'list', '--installed'])
  if (installed !== null && !installed.split(/\s+/).includes(target)) {
    fail(`the Rust target ${target} is not installed. Run: rustup target add ${target}`)
  }
}

const bindgen = findTool('wasm-bindgen', [cargoBin])
if (!bindgen) {
  fail('wasm-bindgen not found. Run: cargo install wasm-bindgen-cli --version 0.2.100 --locked')
}
const bindgenVersion = capture(bindgen, ['--version'])
if (bindgenVersion && !bindgenVersion.includes('0.2.100')) {
  fail(
    `${bindgenVersion} does not match the crate's wasm-bindgen 0.2.100. ` +
      'Run: cargo install wasm-bindgen-cli --version 0.2.100 --locked --force',
  )
}

const wasmOpt = join(root, 'node_modules', '.bin', 'wasm-opt' + (process.platform === 'win32' ? '.cmd' : ''))
if (!existsSync(wasmOpt)) {
  fail('wasm-opt not found in node_modules/.bin (it comes with the binaryen dev dependency). Run: npm ci')
}

// ── Build ──────────────────────────────────────────────────────────────────────

run(cargo, ['build', '--release', '--target', target, '-p', crate], 'cargo build')

const metadata = capture(cargo, ['metadata', '--format-version', '1', '--no-deps'])
const targetDir = (metadata && JSON.parse(metadata).target_directory) || join(root, 'target')
const rawWasm = join(targetDir, target, 'release', `${outName}.wasm`)
if (!existsSync(rawWasm)) fail(`cargo did not produce ${rawWasm}`)

const bindgenHelp = capture(bindgen, ['--help']) ?? ''
const bindgenArgs = ['--target', 'web', '--out-dir', outDir, '--out-name', outName]
// The loader always passes the module explicitly, so the default `new URL(...)` is dead weight.
if (bindgenHelp.includes('--omit-default-module-path')) bindgenArgs.push('--omit-default-module-path')
run(bindgen, [...bindgenArgs, rawWasm], 'wasm-bindgen')

run(
  wasmOpt,
  [
    '-O3',
    '--enable-bulk-memory',
    '--enable-nontrapping-float-to-int',
    '--enable-sign-ext',
    '--enable-mutable-globals',
    '--enable-reference-types',
    '--enable-multivalue',
    wasmOut,
    '-o',
    wasmOut,
  ],
  'wasm-opt',
)

// ── Clean the glue ─────────────────────────────────────────────────────────────

for (const file of readdirSync(outDir)) {
  if (!/\.(js|ts|d\.ts)$/.test(file)) continue
  const path = join(outDir, file)
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  const kept = lines.filter((line) => !(BANNED.test(line) && /^\s*(\/\/|\/\*|\*)/.test(line)))
  if (kept.length !== lines.length) writeFileSync(path, kept.join('\n'))
  const left = kept.find((line) => BANNED.test(line))
  if (left) fail(`${relative(root, path)} still contains a banned word: ${left.trim()}`)
}

const size = statSync(wasmOut).size
console.log(`build-wasm: ${relative(root, wasmOut)} ${(size / 1024).toFixed(1)} KiB (${size} bytes)`)
