//! Douglas–Peucker over many polylines, mirroring `simplifyPathsTs`.

/// Squared distance from `(x, y)` to the segment `a–b`.
#[inline]
fn segment_distance2(x: f64, y: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let vx = bx - ax;
    let vy = by - ay;
    let len2 = vx * vx + vy * vy;
    let mut t = if len2 == 0.0 {
        0.0
    } else {
        ((x - ax) * vx + (y - ay) * vy) / len2
    };
    // `t < 0 ? 0 : t > 1 ? 1 : t`, NaN included.
    t = t.clamp(0.0, 1.0);
    let dx = ax + t * vx - x;
    let dy = ay + t * vy - y;
    dx * dx + dy * dy
}

/// Douglas–Peucker over one range `[s, t)` with `t - s >= 3`, every index in bounds:
/// writes `keep[p - base]`. `stack` is scratch space.
#[allow(clippy::too_many_arguments)]
fn simplify_range(
    xs: &[f64],
    ys: &[f64],
    s: usize,
    t: usize,
    tol2: f64,
    keep: &mut [u8],
    base: usize,
    stack: &mut Vec<usize>,
) {
    let (xs, ys) = (&xs[..t], &ys[..t]);
    let keep = &mut keep[s - base..t - base];
    keep.fill(0);
    keep[0] = 1;
    keep[t - s - 1] = 1;
    // Iterative Douglas–Peucker: a stack of (first, last) index pairs, last on top.
    stack.clear();
    stack.push(s);
    stack.push(t - 1);
    while let (Some(last), Some(first)) = (stack.pop(), stack.pop()) {
        let mut max_d = -1.0;
        let mut max_i = usize::MAX;
        let (ax, ay, bx, by) = (xs[first], ys[first], xs[last], ys[last]);
        for p in first + 1..last {
            let d = segment_distance2(xs[p], ys[p], ax, ay, bx, by);
            if d > max_d {
                max_d = d;
                max_i = p;
            }
        }
        if max_i != usize::MAX && max_d > tol2 {
            keep[max_i - s] = 1;
            stack.extend_from_slice(&[first, max_i, max_i, last]);
        }
    }
}

/// The same as [`simplify_range`] for a range reaching past `xs`, `ys` or `keep`: indices
/// past the end of `xs`/`ys` read as NaN and writes past the end of `keep` are ignored,
/// as with typed arrays.
fn simplify_range_clipped(
    xs: &[f64],
    ys: &[f64],
    s: usize,
    t: usize,
    tol2: f64,
    keep: &mut [u8],
    stack: &mut Vec<usize>,
) {
    let x = |p: usize| xs.get(p).copied().unwrap_or(f64::NAN);
    let y = |p: usize| ys.get(p).copied().unwrap_or(f64::NAN);
    let set = |keep: &mut [u8], p: usize, v: u8| {
        if let Some(k) = keep.get_mut(p) {
            *k = v;
        }
    };
    let end = t.min(keep.len());
    keep[s.min(end)..end].fill(0);
    set(keep, s, 1);
    set(keep, t - 1, 1);
    stack.clear();
    stack.push(s);
    stack.push(t - 1);
    while let (Some(last), Some(first)) = (stack.pop(), stack.pop()) {
        let mut max_d = -1.0;
        let mut max_i = usize::MAX;
        let (ax, ay, bx, by) = (x(first), y(first), x(last), y(last));
        for p in first + 1..last {
            let d = segment_distance2(x(p), y(p), ax, ay, bx, by);
            if d > max_d {
                max_d = d;
                max_i = p;
            }
        }
        if max_i != usize::MAX && max_d > tol2 {
            set(keep, max_i, 1);
            stack.extend_from_slice(&[first, max_i, max_i, last]);
        }
    }
}

/// Simplifies every range `[starts[e], ends[e])`: writes 1 into `keep[p]` for kept points
/// and 0 for dropped ones; ranges under three points keep every point, and points outside
/// every range are left untouched. Indices past the end of `xs`/`ys` read as NaN and
/// writes past the end of `keep` are ignored, as with typed arrays.
pub fn simplify_paths(xs: &[f64], ys: &[f64], starts: &[u32], ends: &[u32], tolerance: f64, keep: &mut [u8]) {
    phase!("simplify::simplify_paths");
    let tol2 = tolerance * tolerance;
    let in_bounds = xs.len().min(ys.len()).min(keep.len());
    let mut stack: Vec<usize> = Vec::with_capacity(64);
    for (&s, &t) in starts.iter().zip(ends) {
        let (s, t) = (s as usize, t as usize);
        if t <= s {
            continue;
        }
        if t - s < 3 {
            let end = t.min(keep.len());
            keep[s.min(end)..end].fill(1);
            continue;
        }
        if t <= in_bounds {
            simplify_range(xs, ys, s, t, tol2, keep, 0, &mut stack);
        } else {
            simplify_range_clipped(xs, ys, s, t, tol2, keep, &mut stack);
        }
    }
}

/// A fixed set of polylines held between simplifications (one per zoom level, say).
///
/// When the ranges cover `[lo, hi)` without a gap and lie inside the point arrays (the
/// usual layout: paths packed one after another), [`PathSet::simplify`] returns the keep
/// mask of exactly that span, which the caller copies into its own mask at `lo`: every
/// covered point is written and nothing else is. Otherwise use [`PathSet::simplify_into`].
#[derive(Debug, Clone, Default)]
pub struct PathSet {
    xs: Vec<f64>,
    ys: Vec<f64>,
    starts: Vec<u32>,
    ends: Vec<u32>,
    lo: usize,
    hi: usize,
    contiguous: bool,
}

impl PathSet {
    /// The range count is `min(starts.len(), ends.len())`.
    pub fn new(xs: Vec<f64>, ys: Vec<f64>, mut starts: Vec<u32>, mut ends: Vec<u32>) -> Self {
        phase!("simplify::PathSet::new");
        let count = starts.len().min(ends.len());
        starts.truncate(count);
        ends.truncate(count);
        let valid = || {
            starts
                .iter()
                .zip(&ends)
                .map(|(&s, &t)| (s as usize, t as usize))
                .filter(|&(s, t)| t > s)
        };
        let lo = valid().map(|r| r.0).min().unwrap_or(0);
        let hi = valid().map(|r| r.1).max().unwrap_or(0);
        let mut contiguous = hi <= xs.len().min(ys.len());
        if contiguous && hi > lo {
            // Coverage counts by a difference array: a zero inside [lo, hi) is a gap.
            let mut diff = vec![0i32; hi - lo + 1];
            for (s, t) in valid() {
                diff[s - lo] += 1;
                diff[t - lo] -= 1;
            }
            let mut depth = 0i32;
            contiguous = diff[..hi - lo].iter().all(|&d| {
                depth += d;
                depth > 0
            });
        }
        PathSet {
            xs,
            ys,
            starts,
            ends,
            lo,
            hi,
            contiguous,
        }
    }

    /// Whether [`PathSet::simplify`] applies (see the type documentation).
    pub fn contiguous(&self) -> bool {
        self.contiguous
    }

    /// First covered point index (0 when there are no ranges).
    pub fn lo(&self) -> usize {
        self.lo
    }

    /// The keep mask of points `lo .. lo + len` for a contiguous set (empty otherwise).
    pub fn simplify(&self, tolerance: f64) -> Vec<u8> {
        phase!("simplify::PathSet::simplify");
        if !self.contiguous {
            return Vec::new();
        }
        let tol2 = tolerance * tolerance;
        let (lo, hi) = (self.lo, self.hi);
        let mut mask = vec![0u8; hi - lo];
        let mut stack: Vec<usize> = Vec::with_capacity(64);
        for (&s, &t) in self.starts.iter().zip(&self.ends) {
            let (s, t) = (s as usize, t as usize);
            if t <= s {
                continue;
            }
            if t - s < 3 {
                mask[s - lo..t - lo].fill(1);
            } else {
                simplify_range(&self.xs, &self.ys, s, t, tol2, &mut mask, lo, &mut stack);
            }
        }
        mask
    }

    /// [`simplify_paths`] over the held polylines, for any layout.
    pub fn simplify_into(&self, tolerance: f64, keep: &mut [u8]) {
        simplify_paths(&self.xs, &self.ys, &self.starts, &self.ends, tolerance, keep);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(xs: &[f64], ys: &[f64], ranges: &[(u32, u32)], tol: f64, keep: &mut [u8]) {
        let starts: Vec<u32> = ranges.iter().map(|r| r.0).collect();
        let ends: Vec<u32> = ranges.iter().map(|r| r.1).collect();
        simplify_paths(xs, ys, &starts, &ends, tol, keep);
    }

    #[test]
    fn distance_to_segment() {
        assert_eq!(segment_distance2(1.0, 1.0, 0.0, 0.0, 2.0, 0.0), 1.0);
        assert_eq!(segment_distance2(-3.0, 4.0, 0.0, 0.0, 2.0, 0.0), 25.0);
        assert_eq!(segment_distance2(5.0, 4.0, 2.0, 0.0, 2.0, 0.0), 25.0);
        assert!(segment_distance2(f64::NAN, 0.0, 0.0, 0.0, 1.0, 0.0).is_nan());
    }

    #[test]
    fn straight_line_collapses() {
        let xs = [0.0, 1.0, 2.0, 3.0, 4.0];
        let mut keep = [9; 5];
        run(&xs, &[0.0; 5], &[(0, 5)], 0.1, &mut keep);
        assert_eq!(keep, [1, 0, 0, 0, 1]);
    }

    #[test]
    fn zig_zag_above_tolerance_is_kept() {
        let xs = [0.0, 1.0, 2.0, 3.0, 4.0];
        let ys = [0.0, 1.0, 0.0, 1.0, 0.0];
        let mut keep = [9; 5];
        run(&xs, &ys, &[(0, 5)], 0.5, &mut keep);
        assert_eq!(keep, [1; 5]);
        run(&xs, &ys, &[(0, 5)], 1.0, &mut keep);
        assert_eq!(keep, [1, 0, 0, 0, 1]);
    }

    #[test]
    fn tolerance_comparison_is_strict() {
        let mut keep = [9; 3];
        run(&[0.0, 1.0, 2.0], &[0.0, 1.0, 0.0], &[(0, 3)], 1.0, &mut keep);
        assert_eq!(keep, [1, 0, 1]);
        run(&[0.0, 1.0, 2.0], &[0.0, 1.0, 0.0], &[(0, 3)], 0.999, &mut keep);
        assert_eq!(keep, [1, 1, 1]);
    }

    #[test]
    fn short_and_empty_ranges_and_untouched_points() {
        let xs = [0.0, 5.0, 9.0, 0.0, 1.0, 2.0, 3.0];
        let ys = [0.0, 5.0, 9.0, 0.0, 0.0, 0.0, 0.0];
        let mut keep = [7; 7];
        run(&xs, &ys, &[(0, 2), (3, 3), (5, 4), (3, 6)], 0.1, &mut keep);
        assert_eq!(keep, [1, 1, 7, 1, 0, 1, 7]);
        run(&[], &[], &[], 1.0, &mut []);
    }

    #[test]
    fn nan_points_and_short_buffers() {
        let xs = [0.0, f64::NAN, 2.0, 3.0];
        let ys = [0.0, 0.0, 5.0, 0.0];
        let mut keep = [9; 4];
        run(&xs, &ys, &[(0, 4)], 0.1, &mut keep);
        assert_eq!(keep, [1, 0, 1, 1]);
        // A range past the end of every array: no panic, writes clipped.
        let mut keep = [9; 2];
        run(&xs[..1], &ys[..1], &[(0, 6)], 0.1, &mut keep);
        assert_eq!(keep, [1, 0]);
    }

    fn via_set(xs: &[f64], ys: &[f64], ranges: &[(u32, u32)], tol: f64, keep: &mut [u8]) -> bool {
        let set = PathSet::new(
            xs.to_vec(),
            ys.to_vec(),
            ranges.iter().map(|r| r.0).collect(),
            ranges.iter().map(|r| r.1).collect(),
        );
        if !set.contiguous() {
            set.simplify_into(tol, keep);
            return false;
        }
        let mask = set.simplify(tol);
        let lo = set.lo().min(keep.len());
        let room = (keep.len() - lo).min(mask.len());
        keep[lo..lo + room].copy_from_slice(&mask[..room]);
        true
    }

    #[test]
    fn path_set_matches_the_one_shot_kernel() {
        let xs: Vec<f64> = (0..40).map(|i| f64::from(i) * 0.5).collect();
        let ys: Vec<f64> = (0..40).map(|i| f64::from((i * 7919) % 13) * 0.3).collect();
        let cases: Vec<(Vec<(u32, u32)>, bool)> = vec![
            (vec![], true),
            (vec![(0, 10), (10, 12), (12, 30)], true),
            (vec![(12, 30), (0, 10), (10, 12), (5, 5)], true), // out of order, one empty
            (vec![(3, 20), (10, 25)], true),                   // overlapping
            (vec![(0, 10), (12, 30)], false),                  // a gap
            (vec![(0, 10), (10, 45)], false),                  // past the points
            (vec![(38, 40)], true),
        ];
        for (ranges, contiguous) in cases {
            for tol in [0.0, 0.2, 1.0, 5.0] {
                for len in [40, 25, 0] {
                    let mut want = vec![7u8; len];
                    run(&xs, &ys, &ranges, tol, &mut want);
                    let mut got = vec![7u8; len];
                    assert_eq!(
                        via_set(&xs, &ys, &ranges, tol, &mut got),
                        contiguous,
                        "{ranges:?}"
                    );
                    assert_eq!(got, want, "{ranges:?} tol {tol} len {len}");
                }
            }
        }
    }

    #[test]
    fn path_set_span() {
        let set = PathSet::new(vec![0.0; 10], vec![0.0; 10], vec![4, 2], vec![8, 4, 9]);
        assert!(set.contiguous());
        assert_eq!(set.lo(), 2);
        assert_eq!(set.simplify(1.0), vec![1, 1, 1, 0, 0, 1]);
        let empty = PathSet::new(vec![], vec![], vec![], vec![]);
        assert!(empty.contiguous() && empty.simplify(1.0).is_empty());
    }
}
