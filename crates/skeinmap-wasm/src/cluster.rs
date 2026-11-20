//! Grid clustering, mirroring `computeClusterLevelTs`.
//!
//! Cells are keyed with the same double operations as the level of detail (and the
//! TypeScript kernel); a NaN key makes a cluster of its own. Cluster ids follow the first
//! appearance of their cell in node index order and the centroid sums are accumulated in
//! that order too, so the output is identical to the TypeScript kernel's, bit for bit.

use crate::lod::{pow2, HIDDEN_STYLE};
use crate::table::{key_bits, KeyTable};

/// `cluster_of` of a hidden node.
pub const NO_CLUSTER: u32 = u32::MAX;

/// Positions clustered at several zooms (copied once).
#[derive(Debug, Clone, Default)]
pub struct Clusterer {
    unit_x: Vec<f64>,
    unit_y: Vec<f64>,
    node_style: Vec<u8>,
    bounds: [f64; 4],
}

/// One clustering (see `ClusterLevel` in `src/kernels/types.ts`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Level {
    pub cluster_of: Vec<u32>,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub count: Vec<u32>,
}

impl Clusterer {
    /// `count` nodes; shorter arrays read like missing typed-array entries in JavaScript
    /// (NaN coordinates, style 0). `bounds` is `[x0, y0, x1, y1]`; cells are counted from
    /// `(x0, y0)`.
    pub fn new(
        mut unit_x: Vec<f64>,
        mut unit_y: Vec<f64>,
        mut node_style: Vec<u8>,
        count: usize,
        bounds: [f64; 4],
    ) -> Self {
        phase!("cluster::Clusterer::new");
        unit_x.resize(count, f64::NAN);
        unit_y.resize(count, f64::NAN);
        node_style.resize(count, 0);
        Clusterer {
            unit_x,
            unit_y,
            node_style,
            bounds,
        }
    }

    /// The clusters at `zoom` (one unit is `2^zoom` pixels) with cells `cell_px` wide.
    pub fn level(&self, zoom: f64, cell_px: f64) -> Level {
        phase!("cluster::level");
        let cell = cell_px / pow2(zoom);
        let [bx0, by0, bx1, by1] = self.bounds;
        let cols = ((bx1 - bx0) / cell).ceil() + 1.0;
        let n = self.unit_x.len();
        // Sizing only (never affects the output): at most one cluster per cell, plus NaNs.
        let cells = cols * (((by1 - by0) / cell).ceil() + 1.0);
        let expected = if cells >= 0.0 && cells < n as f64 {
            cells as usize
        } else {
            n
        };
        let mut table = KeyTable::new(expected);
        let mut cluster_of = Vec::with_capacity(n);
        let cap = expected.saturating_add(16).min(n);
        let mut sx: Vec<f64> = Vec::with_capacity(cap);
        let mut sy: Vec<f64> = Vec::with_capacity(cap);
        let mut count: Vec<u32> = Vec::with_capacity(cap);
        {
            phase!("cluster::level/assign");
            for i in 0..n {
                if self.node_style[i] == HIDDEN_STYLE {
                    cluster_of.push(NO_CLUSTER);
                    continue;
                }
                let x = self.unit_x[i];
                let y = self.unit_y[i];
                let c = ((x - bx0) / cell).floor() + ((y - by0) / cell).floor() * cols;
                let id = if c.is_nan() {
                    // A NaN key matches nothing: a cluster of its own.
                    count.len()
                } else {
                    let v = table.payload(key_bits(c), 0);
                    if *v == 0 {
                        *v = count.len() as u32 + 1;
                        count.len()
                    } else {
                        (*v - 1) as usize
                    }
                };
                if id == count.len() {
                    sx.push(0.0);
                    sy.push(0.0);
                    count.push(0);
                }
                cluster_of.push(id as u32);
                sx[id] += x;
                sy[id] += y;
                count[id] += 1;
            }
        }
        phase!("cluster::level/centroids");
        let x = sx.iter().zip(&count).map(|(s, &k)| s / f64::from(k)).collect();
        let y = sy.iter().zip(&count).map(|(s, &k)| s / f64::from(k)).collect();
        Level {
            cluster_of,
            x,
            y,
            count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORLD: [f64; 4] = [0.0, 0.0, 256.0, 256.0];

    fn clusterer(xs: &[f64], ys: &[f64], styles: &[u8]) -> Clusterer {
        Clusterer::new(xs.to_vec(), ys.to_vec(), styles.to_vec(), xs.len(), WORLD)
    }

    #[test]
    fn empty() {
        let c = clusterer(&[], &[], &[]);
        assert_eq!(c.level(6.0, 60.0), Level::default());
    }

    #[test]
    fn one_cluster_per_cell_in_order_of_first_appearance() {
        // Zoom 0, cell 4 units: nodes 0, 2 share cell (0, 0); 1 and 3 share (2, 0).
        let c = clusterer(&[1.0, 9.0, 3.0, 10.0, 1.0], &[1.0, 1.0, 2.0, 3.0, 50.0], &[0; 5]);
        let level = c.level(0.0, 4.0);
        assert_eq!(level.cluster_of, vec![0, 1, 0, 1, 2]);
        assert_eq!(level.count, vec![2, 2, 1]);
        assert_eq!(level.x, vec![2.0, 9.5, 1.0]);
        assert_eq!(level.y, vec![1.5, 2.0, 50.0]);
        // Zoom 2: cells of 1 unit: every node alone.
        let level = c.level(2.0, 4.0);
        assert_eq!(level.cluster_of, vec![0, 1, 2, 3, 4]);
        assert_eq!(level.count, vec![1; 5]);
    }

    #[test]
    fn styles_do_not_split_clusters() {
        let c = clusterer(&[1.0, 1.5, 2.0], &[1.0; 3], &[0, 7, 254]);
        assert_eq!(c.level(0.0, 60.0).count, vec![3]);
    }

    #[test]
    fn hidden_nodes_belong_to_no_cluster() {
        let c = clusterer(&[1.0, 1.0, f64::NAN, 2.0], &[1.0; 4], &[255, 0, 255, 3]);
        let level = c.level(0.0, 60.0);
        assert_eq!(level.cluster_of, vec![NO_CLUSTER, 0, NO_CLUSTER, 0]);
        assert_eq!(level.count, vec![2]);
        assert_eq!(level.x, vec![1.5]);
    }

    #[test]
    fn nan_positions_are_singletons() {
        let c = clusterer(
            &[f64::NAN, 1.0, f64::NAN, 1.0],
            &[1.0, 1.0, 1.0, f64::NAN],
            &[0; 4],
        );
        let level = c.level(0.0, 60.0);
        assert_eq!(level.cluster_of, vec![0, 1, 2, 3]);
        assert_eq!(level.count, vec![1; 4]);
        assert!(level.x[0].is_nan() && level.x[1] == 1.0 && level.y[3].is_nan());
    }

    #[test]
    fn centroid_sums_in_index_order() {
        let xs = [0.1, 0.2, 0.3, 1e-17];
        let c = clusterer(&xs, &[0.0; 4], &[0; 4]);
        let level = c.level(0.0, 60.0);
        let want = (((0.0 + 0.1) + 0.2) + 0.3 + 1e-17) / 4.0;
        assert_eq!(level.x, vec![want]);
    }

    #[test]
    fn bounds_set_the_cell_origin() {
        let xs = [0.9, 2.5, 2.9, 3.1];
        let mut c = clusterer(&xs, &[1.0; 4], &[0; 4]);
        assert_eq!(c.level(0.0, 2.0).cluster_of, vec![0, 1, 1, 1]);
        c.bounds = [1.0, 1.0, 11.0, 11.0];
        assert_eq!(c.level(0.0, 2.0).cluster_of, vec![0, 1, 1, 2]);
    }

    #[test]
    fn short_arrays_read_as_nan_and_style_zero() {
        let c = Clusterer::new(vec![1.0, 1.0, 1.0], vec![1.0, 1.0], vec![255], 4, WORLD);
        let level = c.level(0.0, 60.0);
        assert_eq!(level.cluster_of, vec![NO_CLUSTER, 0, 1, 2]);
        assert_eq!(level.count, vec![1, 1, 1]);
    }

    #[test]
    fn many_cells_grow_the_table() {
        let n = 10_000;
        let xs: Vec<f64> = (0..n).map(|i| (i % 100) as f64 * 2.0 + 0.5).collect();
        let ys: Vec<f64> = (0..n).map(|i| (i / 100) as f64 * 2.0 + 0.5).collect();
        let c = clusterer(&xs, &ys, &vec![0; n]);
        let level = c.level(0.0, 2.0);
        assert_eq!(level.count.len(), n);
        assert!(level.cluster_of.iter().enumerate().all(|(i, &k)| k as usize == i));
        let level = c.level(0.0, 4.0);
        assert_eq!(level.count.len(), n / 4);
        assert!(level.count.iter().all(|&k| k == 4));
    }
}
