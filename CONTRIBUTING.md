# Contributing to skeinmap

Thanks for taking the time to help. Bug reports, fixes, documentation and benchmarks are all
welcome. For a larger change, please open an issue first so the approach can be agreed on
before you spend time on it.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security
problems go through [private reporting](SECURITY.md), not public issues.

## Toolchain

- **Node.js 22 or newer** (the version in `.nvmrc` is the one CI uses for linting and the
  docs; the test matrix also covers 24 and 26) and npm.
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
npm test        # builds the WebAssembly package if needed, then runs the test suite
```

## Repository layout

| Path                    | What lives there                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`                  | The TypeScript library: layer, scene, renderers (`render/`), kernels (`kernels/`), level of detail (`lod/`), adapters (`leaflet/`, `maplibre/`, `adapters/`) and React bindings (`react/`). |
| `src/wasm/pkg/`         | The wasm-bindgen output. Built by `npm run build:wasm`, never committed.                                                                                                                    |
| `crates/skeinmap-wasm/` | The Rust crate behind the WebAssembly kernels.                                                                                                                                              |
| `test/`                 | Vitest suites, including the WebAssembly / TypeScript equivalence tests.                                                                                                                    |
| `bench/`                | Benchmarks (`npm run bench`); results go to `bench/results/`.                                                                                                                               |
| `docs/`                 | The documentation site (VitePress) and the API reference (TypeDoc).                                                                                                                         |
| `examples/`             | Runnable examples, including the demo published with the docs.                                                                                                                              |
| `scripts/`              | Build helpers and the packaging smoke test.                                                                                                                                                 |

## Scripts

| Script                  | What it does                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build:wasm`    | Builds the Rust crate for `wasm32-unknown-unknown`, runs wasm-bindgen and wasm-opt into `src/wasm/pkg/`.                                |
| `npm run build`         | Builds the WebAssembly package when stale, then the ESM and CommonJS bundles and type declarations into `dist/`.                        |
| `npm test`              | Runs the Vitest suites.                                                                                                                 |
| `npm run test:rust`     | Runs the Rust unit tests.                                                                                                               |
| `npm run typecheck`     | Type-checks the library, tests and the demo.                                                                                            |
| `npm run lint`          | ESLint and a Prettier check. `npm run format` rewrites files with Prettier.                                                             |
| `npm run bench`         | Runs the kernel benchmarks (TypeScript against WebAssembly).                                                                            |
| `npm run size`          | Checks bundle and `.wasm` sizes against `.size-limit.json`.                                                                             |
| `npm run check:package` | Lints the package with publint and checks its types with are-the-types-wrong.                                                           |
| `npm run smoke`         | Packs the tarball, installs it into a throwaway project and checks Node ESM, Node CommonJS and a Vite build. Run `npm run build` first. |
| `npm run docs:dev`      | Serves the documentation site locally.                                                                                                  |
| `npm run changeset`     | Adds a changeset (see below).                                                                                                           |

Rust code is checked with `cargo fmt --all --check` and
`cargo clippy --workspace --all-targets -- -D warnings` (also with
`--target wasm32-unknown-unknown`); CI runs both.

## Kernels: TypeScript and Rust stay in step

Every hot path exists twice: in TypeScript (`src/kernels/ts.ts`, always available) and in Rust
(`crates/skeinmap-wasm/`, used once `initWasm()` has loaded). Users switch between them for
speed only, so they must produce the same output for the same input.

**Any change to a TypeScript kernel must be mirrored in the Rust crate in the same pull
request, and covered by the equivalence test** (`test/equivalence.test.ts`), which runs both
implementations on the same inputs and compares the results. A change to one side alone will
not be merged.

## Pull requests

- Keep each pull request focused on one change; add or update tests with it.
- Run `npm run lint`, `npm run typecheck` and `npm test` before pushing.
- **Add a changeset** for every user-facing change (behaviour, public API, published files,
  supported environments): run `npx changeset`, pick the semver bump and describe the change in
  a sentence or two. Internal changes (tests, CI, refactors) need none. `npx changeset version`
  turns changesets into the changelog and the next version; pushing the matching `v*` tag
  builds the tarball and attaches it to a GitHub Release (the Package workflow).
- Update the documentation in `docs/` when you change behaviour or the API.

## Why there is no Cargo.lock

The crate is only ever built as a `cdylib` for this package (the `rlib` crate type is there
for `cargo test`), and its only dependency,
`wasm-bindgen`, is pinned to an exact version (`=0.2.100`) that must match the
`wasm-bindgen-cli` used by the build. A lockfile would add nothing but churn, so `Cargo.lock`
is ignored. If you add a Rust dependency, pin it the same way or explain in the pull request
why a range is safe.

## License of contributions

skeinmap is dual licensed under MIT or Apache-2.0, at the user's option. Unless you
explicitly state otherwise, any contribution intentionally submitted for inclusion in this
project by you, as defined in the Apache-2.0 license, shall be dual licensed as above,
without any additional terms or conditions.
