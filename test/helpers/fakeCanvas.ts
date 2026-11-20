/**
 * jsdom has no canvas. This installs a recording 2D context (every call is logged) and
 * makes `getContext('webgl2')` return null, so the layer runs its Canvas 2D path.
 */
export interface Call {
  name: string
  args: unknown[]
}

export class Recording2d {
  calls: Call[] = []
  font = ''
  fillStyle: unknown = ''
  strokeStyle: unknown = ''
  lineWidth = 1
  globalAlpha = 1
  lineCap = ''
  lineJoin = ''
  textAlign = ''
  textBaseline = ''
  constructor(readonly canvas: HTMLCanvasElement) {}
  private rec(name: string, args: unknown[]) {
    this.calls.push({ name, args })
  }
  setTransform(...a: unknown[]) {
    this.rec('setTransform', a)
  }
  clearRect(...a: unknown[]) {
    this.rec('clearRect', a)
  }
  beginPath() {
    this.rec('beginPath', [])
  }
  moveTo(...a: unknown[]) {
    this.rec('moveTo', a)
  }
  lineTo(...a: unknown[]) {
    this.rec('lineTo', a)
  }
  arc(...a: unknown[]) {
    this.rec('arc', a)
  }
  closePath() {
    this.rec('closePath', [])
  }
  stroke() {
    this.rec('stroke', [])
  }
  fill() {
    this.rec('fill', [])
  }
  setLineDash(...a: unknown[]) {
    this.rec('setLineDash', a)
  }
  strokeText(...a: unknown[]) {
    this.rec('strokeText', a)
  }
  fillText(...a: unknown[]) {
    this.rec('fillText', a)
  }
  measureText(text: string) {
    return { width: text.length * 6 }
  }
  count(name: string): number {
    return this.calls.filter((c) => c.name === name).length
  }
  reset() {
    this.calls = []
  }
}

export const contexts = new WeakMap<HTMLCanvasElement, Recording2d>()

export function installFakeCanvas(): void {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext(this: HTMLCanvasElement, kind: string): unknown
  }
  proto.getContext = function (this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null
    let c = contexts.get(this)
    if (!c) {
      c = new Recording2d(this)
      contexts.set(this, c)
    }
    return c
  }
}

/** Run queued animation frames (the layer coalesces repaints onto them). */
export async function flushFrames(): Promise<void> {
  await new Promise((r) => setTimeout(r, 40))
}
