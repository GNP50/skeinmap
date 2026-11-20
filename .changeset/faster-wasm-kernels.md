---
'skeinmap': patch
---

Faster WebAssembly kernels, with output unchanged bit for bit: level of detail is up to about
2× faster on large scenes (a million nodes: 118 → 72 ms at zoom 4, 153 → 73 ms at zoom 8),
the hit-test grid build about 1.1× faster and grid clustering about 1.3× faster.
