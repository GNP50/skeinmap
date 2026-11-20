## What this changes

<!-- A short description of the change and why it is needed. Link the issue it addresses (Fixes #123). -->

## How it was tested

<!-- Tests added or updated, manual checks (browsers, adapters), benchmark numbers for performance work. -->

## Checklist

- [ ] `npm run lint`, `npm run typecheck` and `npm test` pass locally
- [ ] Tests cover the change
- [ ] Kernel changes are made in both TypeScript (`src/kernels/ts.ts`) and Rust (`crates/skeinmap-wasm/`), and covered by the equivalence test
- [ ] A changeset is added (`npx changeset`) if the change is user-facing
- [ ] Documentation in `docs/` is updated if behaviour or the API changed
