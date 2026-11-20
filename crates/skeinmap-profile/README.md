# skeinmap-profile

A native [spanscope](https://github.com/GNP50/spanscope) harness for the Rust kernels in
`crates/skeinmap-wasm`. It is not a workspace member and is never published: the shipped
crate and the WebAssembly build do not depend on spanscope.

The harness compiles the kernel modules straight from `../skeinmap-wasm/src` with
`#[path]`. The kernels mark their phases with `phase!("name")`. In `skeinmap-wasm` that
macro expands to nothing. Here it opens a spanscope span that lasts until the end of the
enclosing block. The public kernel calls are wrapped in `#[spanscope::trace(root)]`
functions, one per case of `bench/run.mjs`.

## Use

```sh
npm run build                                       # dist/ for the scene generator
node crates/skeinmap-profile/dump-scene.mjs         # target/profile-data/{100000,1000000}
cd crates/skeinmap-profile
cargo build --release
./target/release/skeinmap-profile profile 1000000 10 ../../target/profile/run.json
cargo spanscope ../../target/profile/run.json --output ../../target/profile/report
python3 summarize.py ../../target/profile/run.json [../../target/profile/baseline.json]
```

`profile <n> [iterations] [out.json]` runs every kernel on the scene that `bench/run.mjs`
builds (the same seeded generator, dumped as raw arrays). It then writes a spanscope
profile. `summarize.py` prints the self and inclusive time of each span and the median of
each root. With a second profile it also prints the speed-up of each span.

`digest <n>` runs every kernel over a matrix of zooms, cell sizes, tolerances and edge
boxes. It prints one FNV-1a digest per kernel, computed over the exact output bits. An
optimisation must leave every digest unchanged. Compare against digests recorded before
the change:

```sh
./target/release/skeinmap-profile digest 1000000 > before.txt   # on the old code
./target/release/skeinmap-profile digest 1000000 | diff before.txt -
```

The TypeScript↔WebAssembly equivalence tests (`npm test`) remain the reference for
behaviour. The digests add a fast check on scenes of a million nodes.

The harness builds for `x86-64-v2` (see `.cargo/config.toml`). With SSE4.1, `floor` is a
single instruction, as `f64.floor` is in WebAssembly. Native timings still differ from
WebAssembly: fresh large allocations page-fault natively, while the WebAssembly allocator
reuses its linear memory. Confirm a change with `npm run bench`.
