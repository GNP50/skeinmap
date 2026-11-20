# Content Security Policy

skeinmap works under a strict Content Security Policy. It never uses `eval`,
`new Function` or inline scripts, so it never needs `'unsafe-eval'`.

## What each feature needs

| Feature                   | Directive                                                                      | Without it                                                                                |
| ------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| The library itself        | `script-src` allowing your bundle                                              | —                                                                                         |
| WebAssembly kernels       | `script-src 'wasm-unsafe-eval'`                                                | `initWasm()` resolves `false`; the TypeScript kernels keep running, with identical output |
| Fetching the `.wasm` file | `connect-src` allowing its origin (usually `'self'`)                           | Same as above                                                                             |
| Level-of-detail worker    | `worker-src` allowing the worker script (usually `'self'`)                     | The layer computes levels on the main thread                                              |
| Canvases, tooltip         | nothing: styles are set through the CSSOM, which `style-src` does not restrict | —                                                                                         |

`'wasm-unsafe-eval'` allows compiling WebAssembly and nothing else. It is the directive
browsers introduced so that pages using WebAssembly do not have to grant `'unsafe-eval'`.
If your policy cannot include it, skeinmap still works; it is only slower on large scenes.
You can tell from `wasmStatus()` (`'failed'`) and `wasmError()`.

A policy for a page with a Leaflet map and OpenStreetMap tiles:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  worker-src 'self';
  connect-src 'self';
  img-src 'self' data: https://tile.openstreetmap.org;
  style-src 'self'
```

Map libraries have their own requirements — MapLibre GL, for example, needs to fetch its
style and tiles and to start its own workers. Add those according to its documentation.

## Tooltips and cross-site scripting

By default tooltip strings are inserted as text (`textContent`), so data containing `<`,
`&` or quotes is shown literally and cannot inject markup.

`tooltipHtml: true` inserts them as HTML (`innerHTML`). Then **every value that comes from
data must be escaped** — a name like `<img src=x onerror=…>` would otherwise run script in
your page. Use `escapeHtml` for interpolated values, or `tooltipCard`, which escapes the
title, subtitle and every row for you:

```ts
import { escapeHtml, tooltipCard } from 'skeinmap'

// escaped by hand
nodeTooltip: (i) => `<b>${escapeHtml(names[i])}</b>`

// escaped by tooltipCard
nodeTooltip: (i) => tooltipCard(names[i], [['owner', owners[i]]])
```

If your page enforces Trusted Types (`require-trusted-types-for 'script'`), assigning a
plain string to `innerHTML` throws. Keep `tooltipHtml` off in that case, or style the
text-only tooltip with CSS.
