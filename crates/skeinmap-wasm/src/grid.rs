//! Hit-test grid, mirroring `buildGridTs`.

/// Edges covering more cells than this go to [`Grid::long_edges`].
pub const MAX_EDGE_CELLS: i64 = 64;
/// Grids with more cells than this (or with a NaN, infinite or non-positive geometry) come
/// back empty instead of allocating without bound.
pub const MAX_GRID_CELLS: f64 = 67_108_864.0;

/// A rectangle in absolute pixel coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

/// A uniform grid as compressed rows (see `GridData` in `src/kernels/types.ts`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Grid {
    pub cols: u32,
    pub rows: u32,
    pub node_start: Vec<u32>,
    pub node_items: Vec<u32>,
    pub edge_start: Vec<u32>,
    pub edge_items: Vec<u32>,
    pub long_edges: Vec<u32>,
}

impl Grid {
    fn empty() -> Self {
        Grid {
            cols: 1,
            rows: 1,
            node_start: vec![0; 2],
            edge_start: vec![0; 2],
            ..Grid::default()
        }
    }
}

/// `Math.max`: NaN if either argument is NaN.
#[inline]
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

/// The grid over `win` with square cells `cell` wide. `edge_box` holds `[x0, y0, x1, y1]`
/// per edge (NaN in slot 0: use the endpoints); empty means no boxes at all.
#[allow(clippy::too_many_arguments)]
pub fn build_grid(
    node_count: usize,
    edge_from: &[u32],
    edge_to: &[u32],
    proj_x: &[f64],
    proj_y: &[f64],
    edge_box: &[f64],
    win: Window,
    cell: f64,
) -> Grid {
    phase!("grid::build");
    let cols_f = js_max(1.0, ((win.x1 - win.x0) / cell).ceil());
    let rows_f = js_max(1.0, ((win.y1 - win.y0) / cell).ceil());
    if !(cell > 0.0 && cols_f * rows_f <= MAX_GRID_CELLS) {
        return Grid::empty();
    }
    let (cols, rows) = (cols_f as usize, rows_f as usize);
    let cells = cols * rows;
    let (last_col, last_row) = (cols_f - 1.0, rows_f - 1.0);
    let Window {
        x0: wx0,
        y0: wy0,
        x1: wx1,
        y1: wy1,
    } = win;
    let px = |i: usize| proj_x.get(i).copied().unwrap_or(f64::NAN);
    let py = |i: usize| proj_y.get(i).copied().unwrap_or(f64::NAN);
    // `Math.min(last, Math.max(0, v))` for a v that is not NaN.
    let clamp = |v: f64, last: f64| {
        if v < 0.0 {
            0.0
        } else if v > last {
            last
        } else {
            v
        }
    };

    // Nodes: counting sort by cell.
    let mut node_cell = vec![u32::MAX; node_count];
    let mut node_start = vec![0u32; cells + 1];
    let mut inside = 0usize;
    let node_items = {
        phase!("grid::build/nodes");
        for (i, slot) in node_cell.iter_mut().enumerate() {
            let (x, y) = (px(i), py(i));
            if !(x >= wx0 && x < wx1 && y >= wy0 && y < wy1) {
                continue;
            }
            // Never negative here; clamped above: `x - wx0` can round up to the window width.
            let cx = ((x - wx0) / cell).floor().min(last_col) as usize;
            let cy = ((y - wy0) / cell).floor().min(last_row) as usize;
            let c = cy * cols + cx;
            *slot = c as u32;
            node_start[c + 1] += 1;
            inside += 1;
        }
        for c in 0..cells {
            node_start[c + 1] += node_start[c];
        }
        let mut node_items = vec![0u32; inside];
        let mut node_fill = node_start[..cells].to_vec();
        for (i, &c) in node_cell.iter().enumerate() {
            if c != u32::MAX {
                let f = &mut node_fill[c as usize];
                node_items[*f as usize] = i as u32;
                *f += 1;
            }
        }
        drop(node_cell);
        node_items
    };

    // Edges: by every cell their box covers. The first pass counts and records each
    // gridded edge's first cell and its width and height in cells (both at most
    // MAX_EDGE_CELLS; width 0 marks an edge outside the window or a long one).
    let edge_count = edge_from.len();
    let mut edge_start = vec![0u32; cells + 1];
    let mut edge_cell = vec![0u32; edge_count];
    let mut edge_wh = vec![[0u8; 2]; edge_count];
    let mut long_edges = Vec::new();
    {
        phase!("grid::build/edges.count");
        let count = &mut edge_start[1..];
        for e in 0..edge_count {
            let (x0, y0, x1, y1);
            let slot0 = if edge_box.is_empty() {
                Some(f64::NAN)
            } else {
                edge_box.get(e * 4).copied()
            };
            match slot0 {
                // A box shorter than the edge list reads `undefined`, which fails every test.
                None => continue,
                Some(v) if !v.is_nan() => {
                    let at = |k: usize| edge_box.get(e * 4 + k).copied().unwrap_or(f64::NAN);
                    x0 = v;
                    y0 = at(1);
                    x1 = at(2);
                    y1 = at(3);
                }
                Some(_) => {
                    let from = edge_from[e] as usize;
                    let to = edge_to.get(e).map_or(usize::MAX, |&t| t as usize);
                    let (ax, bx, ay, by) = (px(from), px(to), py(from), py(to));
                    x0 = if ax < bx { ax } else { bx };
                    x1 = if ax < bx { bx } else { ax };
                    y0 = if ay < by { ay } else { by };
                    y1 = if ay < by { by } else { ay };
                }
            }
            // NaN coordinates fail every comparison below.
            if !(x1 >= wx0 && x0 <= wx1 && y1 >= wy0 && y0 <= wy1) {
                continue;
            }
            let c0 = clamp(((x0 - wx0) / cell).floor(), last_col) as i64;
            let r0 = clamp(((y0 - wy0) / cell).floor(), last_row) as i64;
            let c1 = clamp(((x1 - wx0) / cell).floor(), last_col) as i64;
            let r1 = clamp(((y1 - wy0) / cell).floor(), last_row) as i64;
            let (w, h) = (c1 - c0 + 1, r1 - r0 + 1);
            if w * h > MAX_EDGE_CELLS {
                long_edges.push(e as u32);
                continue;
            }
            // An inverted box (x1 < x0) covers no cell.
            if w <= 0 || h <= 0 {
                continue;
            }
            let (c0, r0) = (c0 as usize, r0 as usize);
            let first = r0 * cols + c0;
            edge_cell[e] = first as u32;
            edge_wh[e] = [w as u8, h as u8];
            // The rectangle goes into a 2D difference array held in `count` (corners
            // past the last column or row fall off the grid and are skipped).
            let (c1, r1) = (c0 + w as usize, r0 + h as usize);
            count[first] = count[first].wrapping_add(1);
            if c1 < cols {
                count[r0 * cols + c1] = count[r0 * cols + c1].wrapping_sub(1);
            }
            if r1 < rows {
                count[r1 * cols + c0] = count[r1 * cols + c0].wrapping_sub(1);
                if c1 < cols {
                    count[r1 * cols + c1] = count[r1 * cols + c1].wrapping_add(1);
                }
            }
        }
    }
    {
        phase!("grid::build/edges.prefix");
        // Summed along each row, then down the columns, the differences become the edge
        // count of every cell (exact: the true counts fit in 32 bits, so wrapping
        // intermediate values cancel out).
        let count = &mut edge_start[1..];
        for r in 0..rows {
            let row = r * cols;
            let mut run = 0u32;
            for n in &mut count[row..row + cols] {
                run = run.wrapping_add(*n);
                *n = run;
            }
            if r > 0 {
                let (above, here) = count.split_at_mut(row);
                for (n, &up) in here[..cols].iter_mut().zip(&above[row - cols..]) {
                    *n = n.wrapping_add(up);
                }
            }
        }
        for c in 0..cells {
            edge_start[c + 1] += edge_start[c];
        }
    }
    let mut edge_items = vec![0u32; edge_start[cells] as usize];
    let mut edge_fill = edge_start[..cells].to_vec();
    {
        phase!("grid::build/edges.fill");
        for (e, (&first, &[w, h])) in edge_cell.iter().zip(&edge_wh).enumerate() {
            if w == 0 {
                continue;
            }
            let (w, h) = (w as usize, h as usize);
            for row in (first as usize..).step_by(cols).take(h) {
                for f in &mut edge_fill[row..row + w] {
                    edge_items[*f as usize] = e as u32;
                    *f += 1;
                }
            }
        }
    }
    Grid {
        cols: cols as u32,
        rows: rows as u32,
        node_start,
        node_items,
        edge_start,
        edge_items,
        long_edges,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIN: Window = Window {
        x0: 0.0,
        y0: 0.0,
        x1: 40.0,
        y1: 30.0,
    };

    fn cell_items(start: &[u32], items: &[u32], c: usize) -> Vec<u32> {
        items[start[c] as usize..start[c + 1] as usize].to_vec()
    }

    #[test]
    fn nodes_by_cell() {
        let xs = [5.0, 15.0, 5.5, 39.9, 40.0, -0.1, f64::NAN, 0.0];
        let ys = [5.0, 5.0, 6.0, 29.9, 1.0, 1.0, 1.0, f64::NAN];
        let g = build_grid(8, &[], &[], &xs, &ys, &[], WIN, 10.0);
        assert_eq!((g.cols, g.rows), (4, 3));
        assert_eq!(g.node_start.len(), 13);
        assert_eq!(g.node_items, vec![0, 2, 1, 3]);
        assert_eq!(cell_items(&g.node_start, &g.node_items, 0), vec![0, 2]);
        assert_eq!(cell_items(&g.node_start, &g.node_items, 1), vec![1]);
        assert_eq!(cell_items(&g.node_start, &g.node_items, 11), vec![3]);
        assert!(g.edge_items.is_empty() && g.long_edges.is_empty());
    }

    #[test]
    fn edges_by_box_and_long_edges() {
        let xs = [1.0, 12.0, 1.0, 39.0, -100.0, -50.0, f64::NAN];
        let ys = [1.0, 12.0, 1.0, 29.0, 1.0, 1.0, 1.0];
        // 0: cells (0,0)-(1,1); 1: a point; 2: whole window (12 cells, not long at 64);
        // 3: outside; 4: NaN end.
        let from = [0, 0, 0, 4, 6];
        let to = [1, 2, 3, 5, 0];
        let g = build_grid(7, &from, &to, &xs, &ys, &[], WIN, 10.0);
        assert_eq!(cell_items(&g.edge_start, &g.edge_items, 0), vec![0, 1, 2]);
        assert_eq!(cell_items(&g.edge_start, &g.edge_items, 5), vec![0, 2]);
        assert_eq!(cell_items(&g.edge_start, &g.edge_items, 11), vec![2]);
        assert!(g.long_edges.is_empty());
        // At cell 2 edge 2 covers 20 x 15 cells: long. Edge 0 covers 7 x 7 = 49: gridded.
        let g = build_grid(7, &from, &to, &xs, &ys, &[], WIN, 2.0);
        assert_eq!(g.long_edges, vec![2]);
        assert_eq!(g.edge_items.iter().filter(|&&e| e == 0).count(), 49);
    }

    #[test]
    fn edge_boxes() {
        let xs = [1.0, 2.0];
        let ys = [1.0, 2.0];
        let boxes = [
            f64::NAN,
            0.0,
            0.0,
            0.0, // straight: endpoints
            25.0,
            25.0,
            35.0,
            28.0, // routed
            0.0,
            f64::NAN,
            1.0,
            1.0, // NaN in a later slot: rejected
            -1e9,
            -1e9,
            1e9,
            1e9, // covers everything: long
        ];
        let g = build_grid(2, &[0, 0, 0, 0], &[1, 1, 1, 1], &xs, &ys, &boxes, WIN, 10.0);
        assert_eq!(cell_items(&g.edge_start, &g.edge_items, 0), vec![0, 3]);
        assert_eq!(cell_items(&g.edge_start, &g.edge_items, 10), vec![1, 3]);
        assert_eq!(cell_items(&g.edge_start, &g.edge_items, 11), vec![1, 3]);
        assert_eq!(g.edge_items.len(), 15);
        assert!(g.long_edges.is_empty(), "12 cells is not long");
        let g = build_grid(2, &[0, 0, 0, 0], &[1, 1, 1, 1], &xs, &ys, &boxes, WIN, 1.0);
        assert_eq!(g.long_edges, vec![3]);
        // A box list shorter than the edge list: missing boxes are rejected.
        let g = build_grid(2, &[0, 0], &[1, 1], &xs, &ys, &boxes[..4], WIN, 10.0);
        assert_eq!(g.edge_items, vec![0]);
    }

    #[test]
    fn degenerate_windows() {
        let one = |win: Window, cell: f64| build_grid(1, &[0], &[0], &[1.0], &[1.0], &[], win, cell);
        let empty = Grid::empty();
        assert_eq!(one(WIN, 0.0), empty);
        assert_eq!(one(WIN, -1.0), empty);
        assert_eq!(one(WIN, f64::NAN), empty);
        assert_eq!(one(Window { x0: f64::NAN, ..WIN }, 10.0), empty);
        assert_eq!(
            one(
                Window {
                    x1: f64::INFINITY,
                    ..WIN
                },
                10.0
            ),
            empty
        );
        assert_eq!(one(WIN, 1e-6), empty);
        // A zero-width window is one column wide and holds nothing.
        let g = one(Window { x1: 0.0, ..WIN }, 10.0);
        assert_eq!((g.cols, g.rows, g.node_items.len()), (1, 3, 0));
        // An infinite cell: one cell for the whole window.
        let g = one(WIN, f64::INFINITY);
        assert_eq!(
            (g.cols, g.rows, g.node_items.clone(), g.edge_items.clone()),
            (1, 1, vec![0], vec![0])
        );
        assert_eq!(
            build_grid(0, &[], &[], &[], &[], &[], WIN, 10.0).node_start,
            vec![0; 13]
        );
    }

    #[test]
    fn a_node_on_the_last_cell_boundary_stays_in_its_row() {
        // (x - x0) rounds up to the window width, so floor((x - x0) / cell) == cols.
        let win = Window {
            x0: -552.0,
            y0: 0.0,
            x1: 528.0,
            y1: 80.0,
        };
        let x = f64::from_bits(528f64.to_bits() - 1);
        assert_eq!(((x - win.x0) / 40.0).floor(), 27.0);
        let g = build_grid(2, &[], &[], &[x, x], &[0.5, 79.0], &[], win, 40.0);
        assert_eq!((g.cols, g.rows), (27, 2));
        assert_eq!(cell_items(&g.node_start, &g.node_items, 26), vec![0]);
        assert_eq!(cell_items(&g.node_start, &g.node_items, 53), vec![1]);
        assert_eq!(g.node_start[54], 2);
    }
}
