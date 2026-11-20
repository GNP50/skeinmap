//! WebAssembly kernels for skeinmap.
//!
//! Every function mirrors its TypeScript counterpart in `src/kernels/ts.ts` operation for
//! operation, so both produce the same output (the test suite compares them). The pure
//! Rust kernels live in their own modules and are tested on the host with `cargo test`;
//! this file only adds the thin `wasm-bindgen` layer used by `src/kernels/wasm.ts`.

/// Marks a named phase of a kernel. It expands to nothing here; the native profiling
/// harness in `crates/skeinmap-profile` compiles the same modules with a `phase!` that
/// opens a spanscope span until the end of the enclosing block.
macro_rules! phase {
    ($name:literal) => {};
}

pub mod cluster;
pub mod grid;
pub mod lod;
pub mod mercator;
pub mod simplify;
mod table;

use wasm_bindgen::prelude::*;

/// Spherical Mercator: longitude/latitude in degrees into units (world 256).
#[wasm_bindgen]
pub fn project_mercator(xs: &[f64], ys: &[f64], out_x: &mut [f64], out_y: &mut [f64]) {
    mercator::project_mercator(xs, ys, out_x, out_y);
}

/// Douglas–Peucker over the ranges `[starts[e], ends[e])`, marking kept points in `keep`.
#[wasm_bindgen]
pub fn simplify_paths(xs: &[f64], ys: &[f64], starts: &[u32], ends: &[u32], tolerance: f64, keep: &mut [u8]) {
    simplify::simplify_paths(xs, ys, starts, ends, tolerance, keep);
}

/// Geometry held in WASM memory between level-of-detail calls.
#[wasm_bindgen]
pub struct LodGeometry {
    inner: lod::Geometry,
}

#[wasm_bindgen]
impl LodGeometry {
    /// Empty path arrays mean no routed edges. `bx0, by0, bx1` are the left, top and right
    /// of the bounds the cells are counted from.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        unit_x: Vec<f64>,
        unit_y: Vec<f64>,
        node_style: Vec<u8>,
        edge_from: Vec<u32>,
        edge_to: Vec<u32>,
        edge_style: Vec<u8>,
        path_start: Vec<u32>,
        path_end: Vec<u32>,
        unit_px: Vec<f64>,
        unit_py: Vec<f64>,
        bx0: f64,
        by0: f64,
        bx1: f64,
    ) -> LodGeometry {
        LodGeometry {
            inner: lod::Geometry::new(lod::GeometryInput {
                unit_x,
                unit_y,
                node_style,
                edge_from,
                edge_to,
                edge_style,
                path_start,
                path_end,
                unit_px,
                unit_py,
                bounds: [bx0, by0, bx1],
            }),
        }
    }

    /// The level for `zoom` (one unit is `2^zoom` pixels) with cells `cell_px` wide.
    pub fn level(&self, zoom: f64, cell_px: f64) -> LodResult {
        LodResult(self.inner.level(zoom, cell_px))
    }
}

/// One level of detail; each `take_*` moves its array out (a second call returns it empty).
#[wasm_bindgen]
pub struct LodResult(lod::Level);

#[wasm_bindgen]
impl LodResult {
    pub fn take_nodes(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.0.nodes)
    }
    pub fn take_seg_edge(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.0.seg_edge)
    }
    pub fn take_seg_p0(&mut self) -> Vec<i32> {
        std::mem::take(&mut self.0.seg_p0)
    }
    pub fn take_seg_p1(&mut self) -> Vec<i32> {
        std::mem::take(&mut self.0.seg_p1)
    }
}

/// A scene topology held in WASM memory between hit-test grid builds.
#[wasm_bindgen]
pub struct GridBuilder {
    node_count: usize,
    edge_from: Vec<u32>,
    edge_to: Vec<u32>,
}

#[wasm_bindgen]
impl GridBuilder {
    #[wasm_bindgen(constructor)]
    pub fn new(node_count: u32, edge_from: Vec<u32>, edge_to: Vec<u32>) -> GridBuilder {
        GridBuilder {
            node_count: node_count as usize,
            edge_from,
            edge_to,
        }
    }

    /// The grid over the window `(x0, y0)–(x1, y1)` with cells `cell` wide. `edge_box`
    /// holds `[x0, y0, x1, y1]` per edge (NaN in slot 0 for a straight edge), or nothing.
    #[allow(clippy::too_many_arguments)]
    pub fn build(
        &self,
        proj_x: &[f64],
        proj_y: &[f64],
        edge_box: &[f64],
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
        cell: f64,
    ) -> GridResult {
        GridResult(grid::build_grid(
            self.node_count,
            &self.edge_from,
            &self.edge_to,
            proj_x,
            proj_y,
            edge_box,
            grid::Window { x0, y0, x1, y1 },
            cell,
        ))
    }
}

/// A hit-test grid; each `take_*` moves its array out (a second call returns it empty).
#[wasm_bindgen]
pub struct GridResult(grid::Grid);

#[wasm_bindgen]
impl GridResult {
    #[wasm_bindgen(getter)]
    pub fn cols(&self) -> u32 {
        self.0.cols
    }
    #[wasm_bindgen(getter)]
    pub fn rows(&self) -> u32 {
        self.0.rows
    }
    pub fn take_node_start(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.0.node_start)
    }
    pub fn take_node_items(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.0.node_items)
    }
    pub fn take_edge_start(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.0.edge_start)
    }
    pub fn take_edge_items(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.0.edge_items)
    }
    pub fn take_long_edges(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.0.long_edges)
    }
}

/// Polylines held in WASM memory between simplifications (copied once).
#[wasm_bindgen]
pub struct PathSet(simplify::PathSet);

#[wasm_bindgen]
impl PathSet {
    /// Points `xs`/`ys`, ranges `[starts[e], ends[e])`.
    #[wasm_bindgen(constructor)]
    pub fn new(xs: Vec<f64>, ys: Vec<f64>, starts: Vec<u32>, ends: Vec<u32>) -> PathSet {
        PathSet(simplify::PathSet::new(xs, ys, starts, ends))
    }

    /// Whether the ranges cover `lo ..` without a gap, inside the points: then `simplify`
    /// applies, otherwise `simplify_into`.
    #[wasm_bindgen(getter)]
    pub fn contiguous(&self) -> bool {
        self.0.contiguous()
    }

    /// First covered point index.
    #[wasm_bindgen(getter)]
    pub fn lo(&self) -> u32 {
        self.0.lo() as u32
    }

    /// The keep mask of the covered span, to copy into the caller's mask at `lo`.
    pub fn simplify(&self, tolerance: f64) -> Vec<u8> {
        self.0.simplify(tolerance)
    }

    /// Writes the keep mask into `keep` directly (any layout).
    pub fn simplify_into(&self, tolerance: f64, keep: &mut [u8]) {
        self.0.simplify_into(tolerance, keep);
    }
}

/// Positions held in WASM memory between clusterings (copied once).
#[wasm_bindgen]
pub struct Clusterer(cluster::Clusterer);

#[wasm_bindgen]
impl Clusterer {
    /// `count` nodes; `bx0, by0, bx1, by1` are the bounds the cells are counted from.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        unit_x: Vec<f64>,
        unit_y: Vec<f64>,
        node_style: Vec<u8>,
        count: u32,
        bx0: f64,
        by0: f64,
        bx1: f64,
        by1: f64,
    ) -> Clusterer {
        Clusterer(cluster::Clusterer::new(
            unit_x,
            unit_y,
            node_style,
            count as usize,
            [bx0, by0, bx1, by1],
        ))
    }

    /// The clusters at `zoom` (one unit is `2^zoom` pixels) with cells `cell_px` wide.
    pub fn level(&self, zoom: f64, cell_px: f64) -> ClusterResult {
        ClusterResult(self.0.level(zoom, cell_px))
    }
}

/// One clustering; each `take_*` moves its array out (a second call returns it empty).
#[wasm_bindgen]
pub struct ClusterResult(cluster::Level);

#[wasm_bindgen]
impl ClusterResult {
    pub fn take_cluster_of(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.0.cluster_of)
    }
    pub fn take_x(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.0.x)
    }
    pub fn take_y(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.0.y)
    }
    pub fn take_count(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.0.count)
    }
}
