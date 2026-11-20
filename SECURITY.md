# Security policy

## Supported versions

skeinmap is in its 0.x series. Security fixes are released for the latest published minor
version only; please upgrade to it before reporting.

| Version          | Supported |
| ---------------- | --------- |
| latest 0.x minor | yes       |
| older versions   | no        |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**. Include the affected version, a
description of the problem and its impact, and the smallest scene, options or steps that
reproduce it.

You can expect an acknowledgement within a week. Once the problem is confirmed, a fix is
prepared in a private fork, released, and a GitHub security advisory is published crediting
the reporter (unless you prefer otherwise).

## Scope notes

Some behaviour is by design and documented; please read these before reporting.

- **HTML tooltips.** Tooltip strings are inserted as text by default. With
  `tooltipHtml: true` they are inserted as HTML, and **the caller must escape every value**
  that comes from data (`escapeHtml` and `tooltipCard` are exported for this). An injection
  through unescaped data passed with `tooltipHtml: true` is a bug in the calling application,
  not in skeinmap. An injection with `tooltipHtml` left off, or through `escapeHtml` /
  `tooltipCard`, is in scope.
- **WebAssembly and Content Security Policy.** Compiling the WebAssembly kernels needs
  `'wasm-unsafe-eval'` in `script-src` (never `'unsafe-eval'`). Without it `initWasm()`
  resolves `false` and the TypeScript kernels keep running; nothing else changes. The
  `.wasm` file is loaded from the URL or bytes you pass to `initWasm()`, or from next to the
  package's own module by default; serve it from an origin you trust.
- **Workers.** The level-of-detail worker is created only from the factory you pass in the
  `lod.worker` option; skeinmap never builds a worker from a string or a blob URL.
- **Resource use.** Scenes are plain typed arrays supplied by the caller. Very large or
  malformed scenes can use a lot of memory or CPU; `validateScene` checks invariants during
  development. Denial of service through scene size alone is out of scope.
