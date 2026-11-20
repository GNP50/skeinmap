import { HIDDEN, isRouted, type Scene } from '../scene'
import { FALLBACK_EDGE_STYLE, FALLBACK_NODE_STYLE, MAX_STYLES, parseCssColor, type SceneStyles } from '../styles'

/**
 * WebGL2 backend: the whole scene lives on the GPU, and a pan or zoom is a handful of
 * uniforms plus two instanced draw calls, so the per-frame cost no longer grows with the
 * number of elements.
 *
 * - Nodes are instanced quads; the fragment shader draws the disc and its stroke with
 *   antialiasing, matching the Canvas 2D look (stroke centred on the radius).
 * - Edges are instanced quads per segment (a routed edge is one instance per segment);
 *   the fragment shader measures the distance to the segment, so caps are round and the
 *   width is exact. Dashed styles use the Canvas 2D pattern (2 on, 4 off).
 * - Positions are uploaded once per scene in units, split into a float32 high and low
 *   part: float32 alone has ~1.5e-5 units of precision, a few pixels at street zoom on a
 *   Mercator map; subtracting the view centre in both parts keeps it sub-pixel.
 * - Styles are uniform arrays indexed by the per-element style byte, so a selection is a
 *   byte write plus re-uploading the style bytes, never the positions.
 *
 * Draw order follows the scene (edges, then nodes, each in index order). One difference
 * from Canvas 2D: overlapping segments of a translucent style accumulate opacity.
 *
 * @module
 */

/** The view as the GPU needs it. */
export interface GlView {
  /** View centre in units. */
  centerX: number
  centerY: number
  /** Pixels per unit. */
  k: number
  rotation: number
  /** Container size in CSS pixels. */
  width: number
  height: number
  dpr: number
  /** Radius/width multiplier. */
  scale: number
}

/** Instances to draw: a node subset and edge segments (see `LodLevel`). */
export interface InstanceSubset {
  nodes: Uint32Array
  segEdge: Uint32Array
  segP0: Int32Array
  segP1: Int32Array
}

export interface GlRenderer {
  setGeometry(scene: Scene, unitX: Float64Array, unitY: Float64Array, unitPX: Float64Array, unitPY: Float64Array): void
  setStyles(scene: Scene, styles: SceneStyles): void
  setLevel(zoom: number, subset: InstanceSubset | null): void
  hasLevel(zoom: number): boolean
  dropLevels(): void
  setOverlay(subset: InstanceSubset): void
  readonly fullSize: number
  readonly lastDrawn: number
  /** Draw; `copies` are unit x offsets at which the scene is drawn again (world copies). */
  draw(view: GlView, levelZoom?: number | null, copies?: readonly number[]): void
  dispose(): void
  readonly lost: boolean
}

const NODE_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_pos;
layout(location=2) in uint a_style;
layout(location=3) in vec4 a_color;
layout(location=4) in float a_size;
uniform vec2 u_centerHi;
uniform vec2 u_centerLo;
uniform float u_k;
uniform vec2 u_rot;
uniform vec2 u_size;
uniform float u_scale;
uniform float u_radius[${MAX_STYLES}];
uniform float u_strokeW[${MAX_STYLES}];
uniform vec4 u_fill[${MAX_STYLES}];
uniform vec4 u_stroke[${MAX_STYLES}];
out vec2 v_local;
flat out float v_r;
flat out float v_sw;
flat out vec4 v_fill;
flat out vec4 v_stroke;
vec2 toScreen(vec4 pos) {
  vec2 d = ((pos.xy - u_centerHi) + (pos.zw - u_centerLo)) * u_k;
  return vec2(u_rot.x * d.x - u_rot.y * d.y, u_rot.y * d.x + u_rot.x * d.y) + u_size * 0.5;
}
void main() {
  v_local = vec2(0.0);
  v_r = 0.0;
  v_sw = 0.0;
  v_fill = vec4(0.0);
  v_stroke = vec4(0.0);
  if (a_style == ${HIDDEN}u) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 px = toScreen(a_pos);
  uint s = min(a_style, ${MAX_STYLES - 1}u);
  float r = max(1.0, (a_size > 0.0 ? a_size : u_radius[s]) * u_scale);
  float sw = u_strokeW[s];
  float outer = r + sw * 0.5 + 1.0;
  v_local = a_corner * outer;
  v_r = r;
  v_sw = sw;
  v_fill = a_color.a > 0.0 ? a_color : u_fill[s];
  v_stroke = u_stroke[s];
  vec2 p = px + v_local;
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
}`

const NODE_FS = `#version 300 es
precision highp float;
in vec2 v_local;
flat in float v_r;
flat in float v_sw;
flat in vec4 v_fill;
flat in vec4 v_stroke;
out vec4 o;
void main() {
  float dist = length(v_local);
  float fillCov = clamp(v_r + 0.5 - dist, 0.0, 1.0);
  vec4 c = vec4(v_fill.rgb * v_fill.a, v_fill.a) * fillCov;
  if (v_sw > 0.0) {
    float strokeCov = clamp(v_sw * 0.5 + 0.5 - abs(dist - v_r), 0.0, 1.0) * v_stroke.a;
    c = vec4(v_stroke.rgb, 1.0) * strokeCov + c * (1.0 - strokeCov);
  }
  if (c.a <= 0.0) discard;
  o = c;
}`

const EDGE_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_a;
layout(location=2) in vec4 a_b;
layout(location=3) in uint a_style;
layout(location=4) in vec4 a_color;
layout(location=5) in float a_width;
uniform vec2 u_centerHi;
uniform vec2 u_centerLo;
uniform float u_k;
uniform vec2 u_rot;
uniform vec2 u_size;
uniform float u_scale;
uniform vec4 u_color[${MAX_STYLES}];
uniform float u_width[${MAX_STYLES}];
uniform float u_dashed[${MAX_STYLES}];
out vec2 v_local;
flat out float v_len;
flat out float v_halfW;
flat out float v_dashed;
flat out vec4 v_color;
vec2 toScreen(vec4 pos) {
  vec2 d = ((pos.xy - u_centerHi) + (pos.zw - u_centerLo)) * u_k;
  return vec2(u_rot.x * d.x - u_rot.y * d.y, u_rot.y * d.x + u_rot.x * d.y) + u_size * 0.5;
}
void main() {
  v_local = vec2(0.0);
  v_len = 0.0;
  v_halfW = 0.0;
  v_dashed = 0.0;
  v_color = vec4(0.0);
  if (a_style == ${HIDDEN}u) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 pa = toScreen(a_a);
  vec2 pb = toScreen(a_b);
  vec2 dir = pb - pa;
  float len = length(dir);
  vec2 t = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  uint s = min(a_style, ${MAX_STYLES - 1}u);
  float halfW = max(0.5, (a_width > 0.0 ? a_width : u_width[s]) * u_scale) * 0.5;
  float ext = halfW + 1.0;
  float along = mix(-ext, len + ext, a_corner.x);
  float across = a_corner.y * ext;
  vec2 p = pa + t * along + n * across;
  v_local = vec2(along, across);
  v_len = len;
  v_halfW = halfW;
  v_dashed = u_dashed[s];
  v_color = a_color.a > 0.0 ? a_color : u_color[s];
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
}`

const EDGE_FS = `#version 300 es
precision highp float;
in vec2 v_local;
flat in float v_len;
flat in float v_halfW;
flat in float v_dashed;
flat in vec4 v_color;
out vec4 o;
void main() {
  float along = v_local.x;
  float dist = along < 0.0 ? length(v_local)
    : along > v_len ? length(v_local - vec2(v_len, 0.0))
    : abs(v_local.y);
  float cov = clamp(v_halfW + 0.5 - dist, 0.0, 1.0);
  if (v_dashed > 0.5 && mod(along, 6.0) > 2.0) discard;
  float a = v_color.a * cov;
  if (a <= 0.0) discard;
  o = vec4(v_color.rgb * a, a);
}`

/** Arrowheads: one triangle per edge whose style has `arrow`, tip on the target's rim. */
const ARROW_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_tip;
layout(location=2) in vec4 a_from;
layout(location=3) in uint a_style;
layout(location=4) in vec4 a_color;
layout(location=5) in float a_nodeR;
uniform vec2 u_centerHi;
uniform vec2 u_centerLo;
uniform float u_k;
uniform vec2 u_rot;
uniform vec2 u_size;
uniform float u_scale;
uniform vec4 u_color[${MAX_STYLES}];
uniform float u_arrow[${MAX_STYLES}];
flat out vec4 v_color;
vec2 toScreen(vec4 pos) {
  vec2 d = ((pos.xy - u_centerHi) + (pos.zw - u_centerLo)) * u_k;
  return vec2(u_rot.x * d.x - u_rot.y * d.y, u_rot.y * d.x + u_rot.x * d.y) + u_size * 0.5;
}
void main() {
  v_color = vec4(0.0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  if (a_style == ${HIDDEN}u) return;
  uint s = min(a_style, ${MAX_STYLES - 1}u);
  float len = u_arrow[s] * u_scale;
  vec2 tip = toScreen(a_tip);
  vec2 d = tip - toScreen(a_from);
  float dist = length(d);
  float r = max(1.0, a_nodeR * u_scale);
  if (len <= 0.0 || dist < len * 1.5 + r) return;
  vec2 t = d / dist;
  vec2 n = vec2(-t.y, t.x);
  vec2 p = tip - t * (r + len * a_corner.x) + n * (len * 0.45 * a_corner.y);
  v_color = a_color.a > 0.0 ? a_color : u_color[s];
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
}`

const ARROW_FS = `#version 300 es
precision highp float;
flat in vec4 v_color;
out vec4 o;
void main() {
  if (v_color.a <= 0.0) discard;
  o = vec4(v_color.rgb * v_color.a, v_color.a);
}`

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new Error('createProgram failed')
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type)
    if (!sh) throw new Error('createShader failed')
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`)
    gl.attachShader(program, sh)
    gl.deleteShader(sh)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(program)}`)
  return program
}

/** `(x, y)` as float32 high parts and the float32 of what they miss. */
function splitInto(out: Float32Array, at: number, x: number, y: number): void {
  const hx = Math.fround(x)
  const hy = Math.fround(y)
  out[at] = hx
  out[at + 1] = hy
  out[at + 2] = x - hx
  out[at + 3] = y - hy
}

type Uniforms = Record<string, WebGLUniformLocation | null>

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]): Uniforms {
  const out: Uniforms = {}
  for (const n of names) out[n] = gl.getUniformLocation(p, n)
  return out
}

interface InstanceSet {
  subset: InstanceSubset
  nodeCount: number
  segCount: number
  nodePos: WebGLBuffer
  nodeStyle: WebGLBuffer
  edgePos: WebGLBuffer
  edgeStyle: WebGLBuffer
  nodeColor: WebGLBuffer
  nodeSize: WebGLBuffer
  edgeColor: WebGLBuffer
  edgeWidth: WebGLBuffer
  nodeVao: WebGLVertexArrayObject
  edgeVao: WebGLVertexArrayObject
}

/** The full scene's instances: every node, one segment per straight edge and one per
 *  polyline segment of a routed edge. */
export function fullSubset(sc: Scene): InstanceSubset {
  const starts = sc.edgePathStart
  const ends = sc.edgePathEnd
  const routed = (e: number) => starts !== undefined && ends !== undefined && ends[e] - starts[e] >= 2
  let segs = 0
  for (let e = 0; e < sc.edgeCount; e++) segs += routed(e) ? ends![e] - starts![e] - 1 : 1
  const segEdge = new Uint32Array(segs)
  const segP0 = new Int32Array(segs)
  const segP1 = new Int32Array(segs)
  let s = 0
  for (let e = 0; e < sc.edgeCount; e++) {
    if (routed(e)) {
      for (let p = starts![e]; p < ends![e] - 1; p++) {
        segEdge[s] = e
        segP0[s] = p
        segP1[s] = p + 1
        s++
      }
    } else {
      segEdge[s] = e
      segP0[s] = -1
      segP1[s] = -1
      s++
    }
  }
  const nodes = new Uint32Array(sc.nodeCount)
  for (let i = 0; i < sc.nodeCount; i++) nodes[i] = i
  return { nodes, segEdge, segP0, segP1 }
}

/** `0xRRGGBBAA` colours of `indices` as RGBA bytes (alpha 0 = "use the style"). */
function gatherColors(colors: Uint32Array, indices: Uint32Array, n: number): Uint8Array {
  const out = new Uint8Array(n * 4)
  for (let k = 0; k < n; k++) {
    const c = colors[indices[k]]
    out[k * 4] = c >>> 24
    out[k * 4 + 1] = (c >>> 16) & 255
    out[k * 4 + 2] = (c >>> 8) & 255
    out[k * 4 + 3] = c & 255
  }
  return out
}

function gatherFloats(values: Float32Array, indices: Uint32Array, n: number): Float32Array {
  const out = new Float32Array(n)
  for (let k = 0; k < n; k++) out[k] = values[indices[k]]
  return out
}

/** Returns null when WebGL2 is unavailable or the shaders do not compile; the caller
 *  then draws with Canvas 2D. */
export function createGlRenderer(canvas: HTMLCanvasElement): GlRenderer | null {
  let context: WebGL2RenderingContext | null
  try {
    context = canvas.getContext('webgl2', {
      premultipliedAlpha: true,
      antialias: false,
      alpha: true,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    })
  } catch {
    context = null
  }
  if (!context) return null
  const gl: WebGL2RenderingContext = context

  let nodeProgram: WebGLProgram
  let edgeProgram: WebGLProgram
  let arrowProgram: WebGLProgram
  try {
    nodeProgram = compile(gl, NODE_VS, NODE_FS)
    edgeProgram = compile(gl, EDGE_VS, EDGE_FS)
    arrowProgram = compile(gl, ARROW_VS, ARROW_FS)
  } catch {
    return null
  }
  const common = ['u_centerHi', 'u_centerLo', 'u_k', 'u_rot', 'u_size', 'u_scale']
  const nodeU = uniforms(gl, nodeProgram, [...common, 'u_radius', 'u_strokeW', 'u_fill', 'u_stroke'])
  const edgeU = uniforms(gl, edgeProgram, [...common, 'u_color', 'u_width', 'u_dashed'])
  const arrowU = uniforms(gl, arrowProgram, [...common, 'u_color', 'u_arrow'])
  // Per-element attributes read this constant when a scene has none: 0 = "use the style".
  for (const loc of [3, 4, 5]) gl.vertexAttrib4f(loc, 0, 0, 0, 0)

  let lost = false
  const onLost = (e: Event) => {
    e.preventDefault()
    lost = true
  }
  canvas.addEventListener('webglcontextlost', onLost)

  const nodeCorners = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, nodeCorners)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const edgeCorners = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, edgeCorners)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW)
  const arrowCorners = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, arrowCorners)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 1, 1, -1]), gl.STATIC_DRAW)

  let scene: Scene | null = null
  let unitX: Float64Array = new Float64Array(0)
  let unitY: Float64Array = new Float64Array(0)
  let unitPX: Float64Array = new Float64Array(0)
  let unitPY: Float64Array = new Float64Array(0)

  function uploadStyleBytes(set: InstanceSet) {
    const sc = scene!
    const sub = set.subset
    const nb = new Uint8Array(set.nodeCount)
    for (let k = 0; k < set.nodeCount; k++) nb[k] = sc.nodeStyle[sub.nodes[k]]
    gl.bindBuffer(gl.ARRAY_BUFFER, set.nodeStyle)
    gl.bufferData(gl.ARRAY_BUFFER, nb, gl.DYNAMIC_DRAW)
    const eb = new Uint8Array(set.segCount)
    for (let s = 0; s < set.segCount; s++) eb[s] = sc.edgeStyle[sub.segEdge[s]]
    gl.bindBuffer(gl.ARRAY_BUFFER, set.edgeStyle)
    gl.bufferData(gl.ARRAY_BUFFER, eb, gl.DYNAMIC_DRAW)
    uploadAttributes(set)
  }

  /** Per-element colours and sizes, or the constant 0 ("use the style") when absent. */
  function uploadAttributes(set: InstanceSet) {
    const sc = scene!
    const sub = set.subset
    const bind = (
      vao: WebGLVertexArrayObject,
      loc: number,
      buf: WebGLBuffer,
      data: ArrayBufferView | null,
      kind: 'color' | 'float',
    ) => {
      gl.bindVertexArray(vao)
      if (!data) {
        gl.disableVertexAttribArray(loc)
      } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf)
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
        gl.enableVertexAttribArray(loc)
        if (kind === 'color') gl.vertexAttribPointer(loc, 4, gl.UNSIGNED_BYTE, true, 0, 0)
        else gl.vertexAttribPointer(loc, 1, gl.FLOAT, false, 0, 0)
        gl.vertexAttribDivisor(loc, 1)
      }
      gl.bindVertexArray(null)
    }
    bind(
      set.nodeVao,
      3,
      set.nodeColor,
      sc.nodeColor ? gatherColors(sc.nodeColor, sub.nodes, set.nodeCount) : null,
      'color',
    )
    bind(
      set.nodeVao,
      4,
      set.nodeSize,
      sc.nodeRadius ? gatherFloats(sc.nodeRadius, sub.nodes, set.nodeCount) : null,
      'float',
    )
    bind(
      set.edgeVao,
      4,
      set.edgeColor,
      sc.edgeColor ? gatherColors(sc.edgeColor, sub.segEdge, set.segCount) : null,
      'color',
    )
    bind(
      set.edgeVao,
      5,
      set.edgeWidth,
      sc.edgeWidth ? gatherFloats(sc.edgeWidth, sub.segEdge, set.segCount) : null,
      'float',
    )
  }

  function uploadPositions(set: InstanceSet) {
    const sc = scene!
    const sub = set.subset
    const n = sub.nodes.length
    const np = new Float32Array(n * 4)
    for (let k = 0; k < n; k++) {
      const i = sub.nodes[k]
      splitInto(np, k * 4, unitX[i], unitY[i])
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, set.nodePos)
    gl.bufferData(gl.ARRAY_BUFFER, np, gl.STATIC_DRAW)
    set.nodeCount = n

    const segs = sub.segEdge.length
    const ep = new Float32Array(segs * 8)
    for (let s = 0; s < segs; s++) {
      const p0 = sub.segP0[s]
      if (p0 < 0) {
        const e = sub.segEdge[s]
        const a = sc.edgeFrom[e]
        const b = sc.edgeTo[e]
        splitInto(ep, s * 8, unitX[a], unitY[a])
        splitInto(ep, s * 8 + 4, unitX[b], unitY[b])
      } else {
        const p1 = sub.segP1[s]
        splitInto(ep, s * 8, unitPX[p0], unitPY[p0])
        splitInto(ep, s * 8 + 4, unitPX[p1], unitPY[p1])
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, set.edgePos)
    gl.bufferData(gl.ARRAY_BUFFER, ep, gl.STATIC_DRAW)
    set.segCount = segs
    uploadStyleBytes(set)
  }

  const createSet = (subset: InstanceSubset): InstanceSet => {
    const nodePos = gl.createBuffer()
    const nodeStyle = gl.createBuffer()
    const edgePos = gl.createBuffer()
    const edgeStyle = gl.createBuffer()
    const nodeColor = gl.createBuffer()
    const nodeSize = gl.createBuffer()
    const edgeColor = gl.createBuffer()
    const edgeWidth = gl.createBuffer()

    const nodeVao = gl.createVertexArray()
    gl.bindVertexArray(nodeVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, nodeCorners)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, nodePos)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0)
    gl.vertexAttribDivisor(1, 1)
    gl.bindBuffer(gl.ARRAY_BUFFER, nodeStyle)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_BYTE, 0, 0)
    gl.vertexAttribDivisor(2, 1)

    const edgeVao = gl.createVertexArray()
    gl.bindVertexArray(edgeVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeCorners)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, edgePos)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0)
    gl.vertexAttribDivisor(1, 1)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16)
    gl.vertexAttribDivisor(2, 1)
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeStyle)
    gl.enableVertexAttribArray(3)
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_BYTE, 0, 0)
    gl.vertexAttribDivisor(3, 1)
    gl.bindVertexArray(null)

    const set: InstanceSet = {
      subset,
      nodeCount: 0,
      segCount: 0,
      nodePos,
      nodeStyle,
      edgePos,
      edgeStyle,
      nodeColor,
      nodeSize,
      edgeColor,
      edgeWidth,
      nodeVao,
      edgeVao,
    }
    uploadPositions(set)
    return set
  }

  const deleteSet = (set: InstanceSet | null) => {
    if (!set) return
    for (const b of [
      set.nodePos,
      set.nodeStyle,
      set.edgePos,
      set.edgeStyle,
      set.nodeColor,
      set.nodeSize,
      set.edgeColor,
      set.edgeWidth,
    ])
      gl.deleteBuffer(b)
    gl.deleteVertexArray(set.nodeVao)
    gl.deleteVertexArray(set.edgeVao)
  }

  let full: InstanceSet | null = null
  let overlay: InstanceSet | null = null
  const levels = new Map<number, InstanceSet | null>()

  // Arrowheads: rebuilt with the styles (which edges carry one depends on them).
  const arrowPos = gl.createBuffer()
  const arrowStyle = gl.createBuffer()
  const arrowColor = gl.createBuffer()
  const arrowNodeR = gl.createBuffer()
  const arrowVao = gl.createVertexArray()
  let arrowCount = 0
  gl.bindVertexArray(arrowVao)
  gl.bindBuffer(gl.ARRAY_BUFFER, arrowCorners)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.bindBuffer(gl.ARRAY_BUFFER, arrowPos)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0)
  gl.vertexAttribDivisor(1, 1)
  gl.enableVertexAttribArray(2)
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16)
  gl.vertexAttribDivisor(2, 1)
  gl.bindBuffer(gl.ARRAY_BUFFER, arrowStyle)
  gl.enableVertexAttribArray(3)
  gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_BYTE, 0, 0)
  gl.vertexAttribDivisor(3, 1)
  gl.bindBuffer(gl.ARRAY_BUFFER, arrowColor)
  gl.enableVertexAttribArray(4)
  gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, 0, 0)
  gl.vertexAttribDivisor(4, 1)
  gl.bindBuffer(gl.ARRAY_BUFFER, arrowNodeR)
  gl.enableVertexAttribArray(5)
  gl.vertexAttribPointer(5, 1, gl.FLOAT, false, 0, 0)
  gl.vertexAttribDivisor(5, 1)
  gl.bindVertexArray(null)

  const rebuildArrows = (styles: SceneStyles) => {
    arrowCount = 0
    const sc = scene
    if (!sc || !styles.edges.some((st) => st && (st.arrow ?? 0) > 0)) return
    const list: number[] = []
    for (let e = 0; e < sc.edgeCount; e++) {
      const si = sc.edgeStyle[e]
      if (si !== HIDDEN && ((styles.edges[si] ?? FALLBACK_EDGE_STYLE).arrow ?? 0) > 0) list.push(e)
    }
    const n = list.length
    const pos = new Float32Array(n * 8)
    const st = new Uint8Array(n)
    const col = new Uint8Array(n * 4)
    const nr = new Float32Array(n)
    for (let k = 0; k < n; k++) {
      const e = list[k]
      const to = sc.edgeTo[e]
      splitInto(pos, k * 8, unitX[to], unitY[to])
      if (isRouted(sc, e)) {
        const p = sc.edgePathEnd![e] - 2
        splitInto(pos, k * 8 + 4, unitPX[p], unitPY[p])
      } else {
        const from = sc.edgeFrom[e]
        splitInto(pos, k * 8 + 4, unitX[from], unitY[from])
      }
      st[k] = sc.edgeStyle[e]
      const c = sc.edgeColor ? sc.edgeColor[e] : 0
      col[k * 4] = c >>> 24
      col[k * 4 + 1] = (c >>> 16) & 255
      col[k * 4 + 2] = (c >>> 8) & 255
      col[k * 4 + 3] = c & 255
      const own = sc.nodeRadius ? sc.nodeRadius[to] : 0
      nr[k] = own > 0 ? own : (styles.nodes[sc.nodeStyle[to]] ?? FALLBACK_NODE_STYLE).radius
    }
    for (const [buf, data] of [
      [arrowPos, pos],
      [arrowStyle, st],
      [arrowColor, col],
      [arrowNodeR, nr],
    ] as const) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
    }
    arrowCount = n
  }
  const arrowTable = new Float32Array(MAX_STYLES)

  const nodeTable = {
    radius: new Float32Array(MAX_STYLES),
    strokeW: new Float32Array(MAX_STYLES),
    fill: new Float32Array(MAX_STYLES * 4),
    stroke: new Float32Array(MAX_STYLES * 4),
  }
  const edgeTable = {
    color: new Float32Array(MAX_STYLES * 4),
    width: new Float32Array(MAX_STYLES),
    dashed: new Float32Array(MAX_STYLES),
  }

  let lastDrawn = 0

  const dropLevels = () => {
    for (const set of levels.values()) deleteSet(set)
    levels.clear()
  }

  const drawSet = (set: InstanceSet, what: 'nodes' | 'edges') => {
    if (what === 'edges' && set.segCount > 0) {
      gl.bindVertexArray(set.edgeVao)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, set.segCount)
    }
    if (what === 'nodes' && set.nodeCount > 0) {
      gl.bindVertexArray(set.nodeVao)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, set.nodeCount)
    }
  }

  return {
    get lost() {
      return lost || gl.isContextLost()
    },
    get fullSize() {
      return full ? full.nodeCount + full.segCount : 0
    },
    get lastDrawn() {
      return lastDrawn
    },
    setGeometry(sc, ux, uy, upx, upy) {
      scene = sc
      unitX = ux
      unitY = uy
      unitPX = upx
      unitPY = upy
      deleteSet(full)
      deleteSet(overlay)
      overlay = null
      dropLevels()
      arrowCount = 0
      full = createSet(fullSubset(sc))
    },
    setStyles(sc, styles) {
      nodeTable.fill.fill(0)
      nodeTable.stroke.fill(0)
      nodeTable.radius.fill(0)
      nodeTable.strokeW.fill(0)
      for (let i = 0; i < MAX_STYLES; i++) {
        const s = styles.nodes[i] ?? FALLBACK_NODE_STYLE
        nodeTable.radius[i] = s.radius
        const hasStroke = !!s.stroke && (s.strokeWidth ?? 0) > 0
        nodeTable.strokeW[i] = hasStroke ? s.strokeWidth! : 0
        nodeTable.fill.set(parseCssColor(s.fill), i * 4)
        if (hasStroke) nodeTable.stroke.set(parseCssColor(s.stroke!), i * 4)
      }
      for (let i = 0; i < MAX_STYLES; i++) {
        const s = styles.edges[i] ?? FALLBACK_EDGE_STYLE
        const c = parseCssColor(s.color)
        edgeTable.color.set([c[0], c[1], c[2], c[3] * (s.opacity ?? 1)], i * 4)
        edgeTable.width[i] = s.width
        edgeTable.dashed[i] = s.dashed ? 1 : 0
        arrowTable[i] = s.arrow ?? 0
      }
      if (sc !== scene) return
      rebuildArrows(styles)
      if (full) uploadStyleBytes(full)
      if (overlay) uploadStyleBytes(overlay)
      for (const set of levels.values()) if (set) uploadStyleBytes(set)
    },
    setLevel(zoom, subset) {
      deleteSet(levels.get(zoom) ?? null)
      levels.set(zoom, subset && scene ? createSet(subset) : null)
    },
    hasLevel(zoom) {
      return levels.has(zoom)
    },
    dropLevels,
    setOverlay(subset) {
      deleteSet(overlay)
      overlay = scene && (subset.nodes.length > 0 || subset.segEdge.length > 0) ? createSet(subset) : null
    },
    draw(view, levelZoom, copies) {
      if (lost || !full) return
      const w = Math.round(view.width * view.dpr)
      const h = Math.round(view.height * view.dpr)
      gl.viewport(0, 0, w, h)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

      const base = (levelZoom != null ? levels.get(levelZoom) : null) ?? full
      lastDrawn = base.nodeCount + base.segCount + (overlay ? overlay.nodeCount + overlay.segCount : 0)

      const cos = Math.cos(view.rotation)
      const sin = Math.sin(view.rotation)
      const offsets = copies && copies.length > 0 ? copies : [0]
      for (const dx of offsets) {
        // Drawing the scene shifted by +dx units is drawing it from a centre shifted by −dx.
        const cx = view.centerX - dx
        const hx = Math.fround(cx)
        const hy = Math.fround(view.centerY)
        const setCommon = (u: Uniforms) => {
          gl.uniform2f(u.u_centerHi, hx, hy)
          gl.uniform2f(u.u_centerLo, cx - hx, view.centerY - hy)
          gl.uniform1f(u.u_k, view.k)
          gl.uniform2f(u.u_rot, cos, sin)
          gl.uniform2f(u.u_size, view.width, view.height)
          gl.uniform1f(u.u_scale, view.scale)
        }

        gl.useProgram(edgeProgram)
        setCommon(edgeU)
        gl.uniform4fv(edgeU.u_color, edgeTable.color)
        gl.uniform1fv(edgeU.u_width, edgeTable.width)
        gl.uniform1fv(edgeU.u_dashed, edgeTable.dashed)
        drawSet(base, 'edges')
        if (overlay) drawSet(overlay, 'edges')

        if (arrowCount > 0) {
          gl.useProgram(arrowProgram)
          setCommon(arrowU)
          gl.uniform4fv(arrowU.u_color, edgeTable.color)
          gl.uniform1fv(arrowU.u_arrow, arrowTable)
          gl.bindVertexArray(arrowVao)
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, arrowCount)
        }

        gl.useProgram(nodeProgram)
        setCommon(nodeU)
        gl.uniform1fv(nodeU.u_radius, nodeTable.radius)
        gl.uniform1fv(nodeU.u_strokeW, nodeTable.strokeW)
        gl.uniform4fv(nodeU.u_fill, nodeTable.fill)
        gl.uniform4fv(nodeU.u_stroke, nodeTable.stroke)
        drawSet(base, 'nodes')
        if (overlay) drawSet(overlay, 'nodes')
      }
      gl.bindVertexArray(null)
    },
    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost)
      deleteSet(full)
      deleteSet(overlay)
      dropLevels()
      full = null
      overlay = null
      for (const b of [nodeCorners, edgeCorners, arrowCorners, arrowPos, arrowStyle, arrowColor, arrowNodeR]) {
        gl.deleteBuffer(b)
      }
      gl.deleteVertexArray(arrowVao)
      gl.deleteProgram(nodeProgram)
      gl.deleteProgram(edgeProgram)
      gl.deleteProgram(arrowProgram)
      // Hand the context back now rather than at garbage collection: browsers cap live
      // WebGL contexts, and a page that recreates layers would otherwise hit the cap.
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
