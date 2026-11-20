import {
  DEFAULT_CLUSTER_CELL_PX,
  type ClusterLevel,
  type Clusterer,
  type GridBuilder,
  type GridData,
  type GridPositions,
  type GridTopology,
  type GridWindow,
  type Kernels,
  type LodComputer,
  type LodGeometry,
  type LodLevel,
  type Simplifier,
} from './types'
import type * as Glue from '../wasm/pkg/skeinmap_wasm.js'

/**
 * The WebAssembly kernels: thin wrappers that move typed arrays across the boundary and
 * back. Geometry that several calls share (a level-of-detail geometry, a grid's edge
 * list) is copied into WASM memory once and held by a Rust object, so a per-zoom call
 * only moves what changed.
 *
 * @module
 */

const EMPTY_U32 = new Uint32Array(0)
const EMPTY_F64 = new Float64Array(0)

/** Frees Rust objects whose JS owner was collected without `dispose()`. */
const registry =
  typeof FinalizationRegistry !== 'undefined'
    ? new FinalizationRegistry<{ free(): void }>((held) => {
        try {
          held.free()
        } catch {
          // Already freed.
        }
      })
    : null

export function createWasmKernels(glue: typeof Glue): Kernels {
  const createClusterer = (
    unitX: Float64Array,
    unitY: Float64Array,
    nodeStyle: Uint8Array,
    count: number,
    bounds?: readonly [number, number, number, number],
  ): Clusterer => {
    const [bx0, by0, bx1, by1] = bounds ?? [0, 0, 256, 256]
    let handle: Glue.Clusterer | null = new glue.Clusterer(
      unitX.subarray(0, count),
      unitY.subarray(0, count),
      nodeStyle.subarray(0, count),
      count,
      bx0,
      by0,
      bx1,
      by1,
    )
    const token = {}
    registry?.register(token, handle, token)
    return {
      level(zoom, cellPx = DEFAULT_CLUSTER_CELL_PX): ClusterLevel {
        if (!handle) throw new Error('Clusterer used after dispose()')
        const r = handle.level(zoom, cellPx)
        try {
          return {
            zoom,
            clusterOf: r.take_cluster_of(),
            x: r.take_x(),
            y: r.take_y(),
            count: r.take_count(),
          }
        } finally {
          r.free()
        }
      },
      dispose() {
        if (!handle) return
        registry?.unregister(token)
        handle.free()
        handle = null
      },
    }
  }

  return {
    name: 'wasm',
    projectMercator(xs, ys, outX, outY, count) {
      if (count === 0) return
      const ox = outX.length === count ? outX : outX.subarray(0, count)
      const oy = outY.length === count ? outY : outY.subarray(0, count)
      glue.project_mercator(xs.subarray(0, count), ys.subarray(0, count), ox, oy)
    },

    createLod(g: LodGeometry): LodComputer {
      const paths = !!(g.edgePathStart && g.edgePathEnd && g.unitPX && g.unitPY)
      const [bx0, by0, bx1] = g.bounds ?? [0, 0, 256, 256]
      let handle: Glue.LodGeometry | null = new glue.LodGeometry(
        g.unitX.subarray(0, g.nodeCount),
        g.unitY.subarray(0, g.nodeCount),
        g.nodeStyle.subarray(0, g.nodeCount),
        g.edgeFrom.subarray(0, g.edgeCount),
        g.edgeTo.subarray(0, g.edgeCount),
        g.edgeStyle.subarray(0, g.edgeCount),
        paths ? g.edgePathStart!.subarray(0, g.edgeCount) : EMPTY_U32,
        paths ? g.edgePathEnd!.subarray(0, g.edgeCount) : EMPTY_U32,
        paths ? g.unitPX! : EMPTY_F64,
        paths ? g.unitPY! : EMPTY_F64,
        bx0,
        by0,
        bx1,
      )
      const token = {}
      registry?.register(token, handle, token)
      return {
        level(zoom, cellPx = 2): LodLevel {
          if (!handle) throw new Error('LodComputer used after dispose()')
          const r = handle.level(zoom, cellPx)
          try {
            return {
              zoom,
              nodes: r.take_nodes(),
              segEdge: r.take_seg_edge(),
              segP0: r.take_seg_p0(),
              segP1: r.take_seg_p1(),
            }
          } finally {
            r.free()
          }
        },
        dispose() {
          if (!handle) return
          registry?.unregister(token)
          handle.free()
          handle = null
        },
      }
    },

    createGridBuilder(t: GridTopology): GridBuilder {
      let handle: Glue.GridBuilder | null = new glue.GridBuilder(
        t.nodeCount,
        t.edgeFrom.subarray(0, t.edgeCount),
        t.edgeTo.subarray(0, t.edgeCount),
      )
      const token = {}
      registry?.register(token, handle, token)
      return {
        build(p: GridPositions, win: GridWindow, cell: number): GridData {
          if (!handle) throw new Error('GridBuilder used after dispose()')
          const r = handle.build(
            p.projX.subarray(0, t.nodeCount),
            p.projY.subarray(0, t.nodeCount),
            p.edgeBox ? p.edgeBox.subarray(0, t.edgeCount * 4) : EMPTY_F64,
            win.x0,
            win.y0,
            win.x1,
            win.y1,
            cell,
          )
          try {
            return {
              win: { ...win },
              cell,
              cols: r.cols,
              rows: r.rows,
              nodeStart: r.take_node_start(),
              nodeItems: r.take_node_items(),
              edgeStart: r.take_edge_start(),
              edgeItems: r.take_edge_items(),
              longEdges: r.take_long_edges(),
            }
          } finally {
            r.free()
          }
        },
        dispose() {
          if (!handle) return
          registry?.unregister(token)
          handle.free()
          handle = null
        },
      }
    },

    simplifyPaths(xs, ys, starts, ends, count, tolerance, keep) {
      if (count === 0) return
      glue.simplify_paths(xs, ys, starts.subarray(0, count), ends.subarray(0, count), tolerance, keep)
    },

    createSimplifier(xs, ys, starts, ends, count): Simplifier {
      let handle: Glue.PathSet | null = new glue.PathSet(xs, ys, starts.subarray(0, count), ends.subarray(0, count))
      // Packed ranges (the usual layout): the kernel returns the mask of the covered span
      // only, copied in place here. Otherwise `keep` goes across and back.
      const contiguous = handle.contiguous
      const lo = handle.lo
      const token = {}
      registry?.register(token, handle, token)
      return {
        simplify(tolerance, keep) {
          if (!handle) throw new Error('Simplifier used after dispose()')
          if (!contiguous) {
            handle.simplify_into(tolerance, keep)
            return
          }
          const mask = handle.simplify(tolerance)
          const room = keep.length - lo
          if (room <= 0 || mask.length === 0) return
          keep.set(room >= mask.length ? mask : mask.subarray(0, room), lo)
        },
        dispose() {
          if (!handle) return
          registry?.unregister(token)
          handle.free()
          handle = null
        },
      }
    },

    clusterLevel(unitX, unitY, nodeStyle, count, zoom, cellPx, bounds) {
      const c = createClusterer(unitX, unitY, nodeStyle, count, bounds)
      try {
        return c.level(zoom, cellPx)
      } finally {
        c.dispose()
      }
    },

    createClusterer,
  }
}
