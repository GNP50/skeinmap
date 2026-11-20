//! Level of detail, mirroring `computeLodLevelTs`.
//!
//! Cell keys are doubles computed with the same operations as the TypeScript kernel, and
//! compared like JavaScript `===` (a NaN key matches nothing), so the kept nodes and the
//! segment lists are identical for every input, including NaN and out-of-range positions.
//! Hidden elements (style [`HIDDEN_STYLE`]) are left out: a hidden node is never kept, a
//! hidden edge produces no segment.

use crate::table::{key_bits, FirstSeen};

// What `level` does with a node or edge.
const DROP: u8 = 0;
const KEEP: u8 = 1;
/// Decided by [`FirstSeen::resolve`].
const PENDING: u8 = 2;
/// An edge drawn along its path.
const ROUTED: u8 = 3;

/// Geometry a level of detail is computed from: positions already in units.
#[derive(Debug, Clone, Default)]
pub struct Geometry {
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
}

/// One level of detail (see `LodLevel` in `src/kernels/types.ts`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Level {
    pub nodes: Vec<u32>,
    pub seg_edge: Vec<u32>,
    pub seg_p0: Vec<i32>,
    pub seg_p1: Vec<i32>,
}

/// Node and edge counts are `unit_x.len()` and `edge_from.len()`. Shorter companion
/// arrays read like missing typed-array entries in JavaScript: NaN coordinates, style 0,
/// and an edge end that refers to no node. Empty path arrays mean no routed edges.
pub struct GeometryInput {
    pub unit_x: Vec<f64>,
    pub unit_y: Vec<f64>,
    pub node_style: Vec<u8>,
    pub edge_from: Vec<u32>,
    pub edge_to: Vec<u32>,
    pub edge_style: Vec<u8>,
    pub path_start: Vec<u32>,
    pub path_end: Vec<u32>,
    pub unit_px: Vec<f64>,
    pub unit_py: Vec<f64>,
    /// Left, top and right of the bounds; cells are counted from `(bx0, by0)`.
    pub bounds: [f64; 3],
}

/// The style byte of a hidden (filtered out) node or edge.
pub const HIDDEN_STYLE: u8 = 255;

/// `Math.pow(2, zoom)`: exact for integer zooms, as V8 is.
pub(crate) fn pow2(zoom: f64) -> f64 {
    if zoom == zoom.trunc() && zoom.abs() <= 1000.0 {
        2f64.powi(zoom as i32)
    } else {
        2f64.powf(zoom)
    }
}

impl Geometry {
    pub fn new(input: GeometryInput) -> Self {
        phase!("lod::Geometry::new");
        let GeometryInput {
            unit_x,
            mut unit_y,
            mut node_style,
            edge_from,
            mut edge_to,
            mut edge_style,
            path_start,
            path_end,
            unit_px,
            unit_py,
            bounds: [bx0, by0, bx1],
        } = input;
        unit_y.resize(unit_x.len(), f64::NAN);
        node_style.resize(unit_x.len(), 0);
        edge_to.resize(edge_from.len(), u32::MAX);
        edge_style.resize(edge_from.len(), 0);
        Geometry {
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
            bx0,
            by0,
            bx1,
        }
    }

    /// The level for `zoom`, where one unit is `2^zoom` pixels; cells are `cell_px` wide.
    pub fn level(&self, zoom: f64, cell_px: f64) -> Level {
        phase!("lod::level");
        let cell = cell_px / pow2(zoom);
        let (bx0, by0) = (self.bx0, self.by0);
        let cols = ((self.bx1 - bx0) / cell).ceil() + 1.0;
        let cell_of = |x: f64, y: f64| ((x - bx0) / cell).floor() + ((y - by0) / cell).floor() * cols;

        // Nodes: one per (cell, style). `state` is DROP, KEEP or PENDING (resolved below).
        let n = self.unit_x.len();
        let mut node_cell = Vec::with_capacity(n);
        let mut state = vec![DROP; n];
        {
            phase!("lod::level/nodes");
            let mut seen = FirstSeen::new(n);
            for (i, st) in state.iter_mut().enumerate() {
                let c = cell_of(self.unit_x[i], self.unit_y[i]);
                node_cell.push(c);
                let style = self.node_style[i];
                if style == HIDDEN_STYLE {
                    continue;
                }
                *st = if c.is_nan() {
                    // A NaN key matches no slot: it gets a fresh one with no style bit set.
                    KEEP
                } else {
                    match seen.check(key_bits(c), 0, 1u32 << (style & 31), i as u32) {
                        Some(true) => KEEP,
                        Some(false) => DROP,
                        None => PENDING,
                    }
                };
            }
            seen.resolve(|i| state[i as usize] = KEEP);
        }
        let nodes = (0..n as u32).filter(|&i| state[i as usize] == KEEP).collect();

        // Edges: decide every edge first (ROUTED for a routed one), then emit in order.
        let m = self.edge_from.len();
        state.clear();
        state.resize(m, DROP);
        // At most one segment per kept or pending straight edge and per routed step.
        let mut most = 0usize;
        {
            phase!("lod::level/edges");
            let mut seen = FirstSeen::new(m);
            for (e, st) in state.iter_mut().enumerate() {
                let style = self.edge_style[e];
                if style == HIDDEN_STYLE {
                    continue;
                }
                if let (Some(&s), Some(&t)) = (self.path_start.get(e), self.path_end.get(e)) {
                    if i64::from(t) - i64::from(s) >= 2 {
                        *st = ROUTED;
                        most += (t - s - 1) as usize;
                        continue;
                    }
                }
                let a = node_cell.get(self.edge_from[e] as usize).copied();
                let b = node_cell.get(self.edge_to[e] as usize).copied();
                *st = match (a, b) {
                    // `undefined === undefined` in the TypeScript kernel.
                    (None, None) => continue,
                    (Some(a), Some(b)) if a == b => continue,
                    (Some(a), Some(b)) if !a.is_nan() && !b.is_nan() => {
                        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
                        match seen.check(key_bits(lo), key_bits(hi), 1u32 << (style & 31), e as u32) {
                            Some(true) => KEEP,
                            Some(false) => DROP,
                            None => PENDING,
                        }
                    }
                    // A NaN (or missing) end makes a NaN pair key: a fresh slot every time.
                    _ => KEEP,
                };
                most += usize::from(*st != DROP);
            }
            seen.resolve(|e| state[e as usize] = KEEP);
        }

        let mut out = Level {
            nodes,
            seg_edge: Vec::with_capacity(most),
            seg_p0: Vec::with_capacity(most),
            seg_p1: Vec::with_capacity(most),
        };
        let path_cell = |p: i64| {
            let p = p as usize;
            let x = self.unit_px.get(p).copied().unwrap_or(f64::NAN);
            let y = self.unit_py.get(p).copied().unwrap_or(f64::NAN);
            cell_of(x, y)
        };
        {
            phase!("lod::level/segments");
            for (e, &st) in state.iter().enumerate() {
                if st == KEEP {
                    out.seg_edge.push(e as u32);
                    out.seg_p0.push(-1);
                    out.seg_p1.push(-1);
                } else if st == ROUTED {
                    // A routed edge: one point per cell it crosses.
                    let (s, t) = (i64::from(self.path_start[e]), i64::from(self.path_end[e]));
                    let mut last = s;
                    let mut last_cell = path_cell(last);
                    for p in (s + 1)..t {
                        let c = path_cell(p);
                        if c == last_cell && p < t - 1 {
                            continue;
                        }
                        if c != last_cell {
                            out.seg_edge.push(e as u32);
                            out.seg_p0.push(last as i32);
                            out.seg_p1.push(p as i32);
                        }
                        last = p;
                        last_cell = c;
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORLD: [f64; 3] = [0.0, 0.0, 256.0];

    fn geometry(xs: &[f64], ys: &[f64], styles: &[u8], edges: &[(u32, u32, u8)]) -> Geometry {
        Geometry::new(GeometryInput {
            unit_x: xs.to_vec(),
            unit_y: ys.to_vec(),
            node_style: styles.to_vec(),
            edge_from: edges.iter().map(|e| e.0).collect(),
            edge_to: edges.iter().map(|e| e.1).collect(),
            edge_style: edges.iter().map(|e| e.2).collect(),
            path_start: vec![],
            path_end: vec![],
            unit_px: vec![],
            unit_py: vec![],
            bounds: WORLD,
        })
    }

    fn straight(level: &Level) -> Vec<u32> {
        assert!(level.seg_p0.iter().chain(&level.seg_p1).all(|&p| p == -1));
        level.seg_edge.clone()
    }

    #[test]
    fn empty_geometry() {
        let g = geometry(&[], &[], &[], &[]);
        assert_eq!(g.level(5.0, 2.0), Level::default());
    }

    #[test]
    fn one_node_per_cell_and_style() {
        // Zoom 0, cell 2: nodes 0, 1 share a cell; 2 has another style; 3 is elsewhere.
        let g = geometry(&[0.5, 1.5, 1.0, 10.0], &[0.5, 1.9, 1.0, 10.0], &[1, 1, 2, 1], &[]);
        assert_eq!(g.level(0.0, 2.0).nodes, vec![0, 2, 3]);
        // At zoom 2 the cell is 0.5 units: every node has its own cell.
        assert_eq!(g.level(2.0, 2.0).nodes, vec![0, 1, 2, 3]);
    }

    #[test]
    fn styles_above_fifteen_do_not_alias() {
        let g = geometry(&[1.0, 1.0, 1.0, 1.0], &[1.0; 4], &[4, 20, 36, 20], &[]);
        // 36 & 31 == 4: same bit as style 4; 20 is distinct from 4.
        assert_eq!(g.level(0.0, 2.0).nodes, vec![0, 1]);
    }

    #[test]
    fn intra_cell_edges_drop_and_pairs_dedup() {
        let xs = [1.0, 1.2, 9.0, 9.1, 30.0];
        let ys = [1.0, 1.2, 9.0, 9.1, 30.0];
        let edges = [
            (0, 1, 0),  // same cell: dropped
            (0, 2, 0),  // cells A-B
            (1, 3, 0),  // A-B again, same style: dropped
            (3, 0, 0),  // B-A, same pair: dropped
            (1, 3, 1),  // A-B with another style: kept
            (2, 4, 0),  // B-C
            (0, 2, 32), // style 32 == style 0: dropped
        ];
        let g = geometry(&xs, &ys, &[0; 5], &edges);
        assert_eq!(straight(&g.level(0.0, 2.0)), vec![1, 4, 5]);
    }

    #[test]
    fn nan_positions_are_kept_and_never_deduplicated() {
        let xs = [f64::NAN, f64::NAN, 1.0, 1.0];
        let ys = [1.0, 1.0, 1.0, 1.0];
        let edges = [
            (0, 1, 0),
            (0, 1, 0),
            (2, 3, 0),
            (0, 2, 0),
            (0, 2, 0),
            (2, 99, 0),
            (98, 99, 0),
        ];
        let g = geometry(&xs, &ys, &[0; 4], &edges);
        let level = g.level(3.0, 2.0);
        assert_eq!(level.nodes, vec![0, 1, 2]);
        // NaN ends: always drawn. A missing end against a real one: drawn. Two missing: dropped.
        assert_eq!(straight(&level), vec![0, 1, 3, 4, 5]);
    }

    #[test]
    fn bounds_set_the_cell_origin() {
        let mut g = geometry(&[0.9, 2.5, 2.9, 3.1], &[1.0; 4], &[0; 4], &[]);
        // Origin 0: cells [0, 2), [2, 4): 0.9 alone, then 2.5, 2.9, 3.1 together.
        assert_eq!(g.level(0.0, 2.0).nodes, vec![0, 1]);
        // Origin 1: cells [-1, 1), [1, 3), [3, 5): 2.5 and 2.9 share one, 3.1 is alone.
        g.bx0 = 1.0;
        g.by0 = 1.0;
        g.bx1 = 11.0;
        assert_eq!(g.level(0.0, 2.0).nodes, vec![0, 1, 3]);
        // Origin 0.5: cells [0.5, 2.5), [2.5, 4.5).
        g.bx0 = 0.5;
        assert_eq!(g.level(0.0, 2.0).nodes, vec![0, 1]);
    }

    #[test]
    fn routed_edges_keep_one_point_per_cell() {
        let mut g = geometry(
            &[0.0, 20.0],
            &[0.0, 0.0],
            &[0, 0],
            &[(0, 1, 0), (0, 1, 0), (0, 1, 0)],
        );
        // Edge 0: points 0..5 cross cells 0,0,1,1,2 (cell 2 units at zoom 0).
        // Edge 1: two points in one cell: no segment. Edge 2: one point: straight.
        g.unit_px = vec![0.1, 0.5, 2.1, 3.0, 4.5, 7.0, 7.5, 9.0];
        g.unit_py = vec![0.0; 8];
        g.path_start = vec![0, 5, 7];
        g.path_end = vec![5, 7, 8];
        let level = g.level(0.0, 2.0);
        assert_eq!(level.seg_edge, vec![0, 0, 2]);
        assert_eq!(level.seg_p0, vec![0, 2, -1]);
        assert_eq!(level.seg_p1, vec![2, 4, -1]);
    }

    #[test]
    fn routed_edge_last_point_in_the_same_cell() {
        let mut g = geometry(&[0.0, 20.0], &[0.0, 0.0], &[0, 0], &[(0, 1, 0)]);
        g.unit_px = vec![0.1, 2.5, 3.0, 3.5];
        g.unit_py = vec![0.0; 4];
        g.path_start = vec![0];
        g.path_end = vec![4];
        let level = g.level(0.0, 2.0);
        assert_eq!((level.seg_p0, level.seg_p1), (vec![0], vec![1]));
    }

    #[test]
    fn missing_path_points_read_as_nan() {
        let mut g = geometry(&[0.0, 20.0], &[0.0, 0.0], &[0, 0], &[(0, 1, 0)]);
        g.unit_px = vec![0.0];
        g.unit_py = vec![0.0];
        g.path_start = vec![0];
        g.path_end = vec![3];
        let level = g.level(0.0, 2.0);
        assert_eq!((level.seg_p0, level.seg_p1), (vec![0, 1], vec![1, 2]));
    }

    #[test]
    fn hidden_nodes_are_never_kept() {
        // Node 0 is hidden: node 1 (same cell, same bit as 255 & 31) represents the cell.
        let g = geometry(&[1.0, 1.0, 1.0, f64::NAN], &[1.0; 4], &[255, 31, 31, 255], &[]);
        assert_eq!(g.level(0.0, 2.0).nodes, vec![1]);
        // A hidden node still places its edges: the edge 0-2 joins two distinct cells.
        let g = geometry(&[1.0, 1.0, 9.0], &[1.0; 3], &[255, 0, 0], &[(0, 2, 0), (1, 2, 0)]);
        let level = g.level(0.0, 2.0);
        assert_eq!(level.nodes, vec![1, 2]);
        assert_eq!(straight(&level), vec![0]);
    }

    #[test]
    fn hidden_edges_produce_no_segments() {
        let mut g = geometry(
            &[0.0, 20.0, f64::NAN],
            &[0.0, 0.0, 0.0],
            &[0, 0, 0],
            &[(0, 1, 255), (0, 1, 31), (0, 1, 255), (0, 2, 255), (0, 1, 255)],
        );
        // Edge 4 is routed (and hidden); the rest are straight.
        g.unit_px = vec![0.1, 2.5, 5.0];
        g.unit_py = vec![0.0; 3];
        g.path_start = vec![0, 0, 0, 0, 0];
        g.path_end = vec![0, 0, 0, 0, 3];
        let level = g.level(0.0, 2.0);
        assert_eq!(level.seg_edge, vec![1]);
        assert_eq!((level.seg_p0, level.seg_p1), (vec![-1], vec![-1]));
    }

    #[test]
    fn integer_zoom_powers_are_exact() {
        assert_eq!(pow2(0.0), 1.0);
        assert_eq!(pow2(15.0), 32768.0);
        assert_eq!(pow2(-3.0), 0.125);
        assert!(pow2(f64::NAN).is_nan());
        assert_eq!(pow2(f64::INFINITY), f64::INFINITY);
    }

    #[test]
    fn short_companion_arrays() {
        let g = Geometry::new(GeometryInput {
            unit_x: vec![1.0, 1.0, 50.0],
            unit_y: vec![1.0],
            node_style: vec![],
            edge_from: vec![0, 0],
            edge_to: vec![2],
            edge_style: vec![],
            path_start: vec![],
            path_end: vec![],
            unit_px: vec![],
            unit_py: vec![],
            bounds: WORLD,
        });
        let level = g.level(0.0, 2.0);
        assert_eq!(level.nodes, vec![0, 1, 2]);
        assert_eq!(level.seg_edge, vec![0, 1]);
    }
}
