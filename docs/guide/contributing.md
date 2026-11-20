# Contributing

Bug reports, fixes, documentation and benchmarks are welcome. For a larger change, open an
issue first so the approach can be agreed on before you spend time on it. The
`CONTRIBUTING.md` file at the root of the repository is the reference; this page mirrors it
and adds how the documentation and the demo are built.

## Toolchain

- **Node.js 22 or newer** and npm.
- **Rust stable** with the WebAssembly target:

  ```sh
  rustup toolchain install stable
  rustup target add wasm32-unknown-unknown
  ```

- **wasm-bindgen-cli 0.2.100**, exactly the version the crate pins:

  ```sh
  cargo install wasm-bindgen-cli --version 0.2.100 --locked
  ```

- `wasm-opt` comes from the `binaryen` dev dependency; nothing to install by hand.

Then:

```sh
npm ci
npm test # builds the WebAssembly package if needed, then runs the test suite
```

## Repository layout

| Path                    | What lives there                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/`                  | The TypeScript library: layer, scene, renderers (`render/`), kernels (`kernels/`), level of detail (`lod/`), adapters (`leaflet/`, `maplibre/`, `adapters/`) and React bindings (`react/`) |
| `src/wasm/pkg/`         | The wasm-bindgen output. Built by `npm run build:wasm`, never committed                                                                                                                    |
| `crates/skeinmap-wasm/` | The Rust crate behind the WebAssembly kernels                                                                                                                                              |
| `test/`                 | Vitest suites, including the WebAssembly / TypeScript equivalence tests                                                                                                                    |
| `bench/`                | Benchmarks (`npm run bench`); results go to `bench/results/`                                                                                                                               |
| `docs/`                 | This site (VitePress) and the API reference (TypeDoc)                                                                                                                                      |
| `examples/demo/`        | The interactive demo, published with the docs                                                                                                                                              |
| `scripts/`              | Build helpers and the packaging smoke test                                                                                                                                                 |

## Scripts

| Script                  | What it does                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run build:wasm`    | Builds the Rust crate for `wasm32-unknown-unknown`, runs wasm-bindgen and wasm-opt into `src/wasm/pkg/`         |
| `npm run build`         | Builds the WebAssembly package when stale, then the ESM and CommonJS bundles and type declarations into `dist/` |
| `npm test`              | Runs the Vitest suites                                                                                          |
| `npm run test:rust`     | Runs the Rust unit tests                                                                                        |
| `npm run typecheck`     | Type-checks the library, the tests and the demo                                                                 |
| `npm run lint`          | ESLint and a Prettier check; `npm run format` rewrites files with Prettier                                      |
| `npm run bench`         | Runs the kernel benchmarks (TypeScript against WebAssembly) on the built package                                |
| `npm run size`          | Checks bundle and `.wasm` sizes against the limits                                                              |
| `npm run check:package` | Lints the package with publint and checks its types with are-the-types-wrong                                    |
| `npm run smoke`         | Packs the tarball, installs it into a throwaway project and checks Node ESM, Node CommonJS and a Vite build     |
| `npm run dev:demo`      | Serves the demo from the sources, with hot reload                                                               |
| `npm run docs:dev`      | Builds the API reference and serves this site locally                                                           |
| `npm run docs:build`    | Builds the API reference, the demo and the site into `docs/.vitepress/dist/`                                    |
| `npm run changeset`     | Adds a changeset                                                                                                |

Rust code is checked with `cargo fmt --all --check` and
`cargo clippy --workspace --all-targets -- -D warnings` (also with
`--target wasm32-unknown-unknown`).

## Keeping the kernels in step

Every hot path exists twice: in TypeScript (`src/kernels/ts.ts`, always available) and in
Rust (`crates/skeinmap-wasm/`, used once `initWasm()` has loaded). Users switch between
them for speed only, so they must produce the same output for the same input.

**Any change to a TypeScript kernel must be mirrored in the Rust crate in the same pull
request and covered by the equivalence test** (`test/equivalence.test.ts`), which runs both
implementations on the same inputs and compares the results. See
[WebAssembly kernels](../concepts/wasm.md#why-the-output-is-the-same).

## Documentation and demo

- Guide and concept pages are Markdown in `docs/`; the navigation is in
  `docs/.vitepress/config.ts`.
- The API reference is built from the TSDoc comments in `src/` by TypeDoc into `docs/api/`
  (not committed). Document a public symbol where it is declared.
- The demo lives in `examples/demo/`. It imports `skeinmap` through Vite aliases that point
  at `src/`, so `npm run dev:demo` reflects source changes without a library build.
  `scripts/build-demo.mjs` builds it into `docs/public/demo/` with the site's base path.
- To build the site for a sub-path, set `DOCS_BASE`, for example
  `DOCS_BASE=/skeinmap/ npm run docs:build`.

## Pull requests

- Keep each pull request focused on one change; add or update tests with it.
- Run `npm run lint`, `npm run typecheck` and `npm test` before pushing.
- Add a changeset (`npm run changeset`) for every user-facing change: behaviour, public API,
  published files, supported environments. Internal changes need none.
- Update the documentation when you change behaviour or the API.
