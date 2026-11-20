//! Spherical Mercator, mirroring `projectMercatorTs`.

use std::f64::consts::PI;

/// Latitude beyond which Mercator is clamped (degrees), as in `src/projection.ts`.
pub const MAX_MERCATOR_LAT: f64 = 85.0511287798;
/// Width and height of the Mercator world in units.
pub const MERCATOR_WORLD: f64 = 256.0;

const DEG: f64 = PI / 180.0;
const INV_4PI: f64 = 1.0 / (4.0 * PI);

/// Projects `(xs[i], ys[i])` (longitude, latitude in degrees) into units for every index
/// that all four slices share.
pub fn project_mercator(xs: &[f64], ys: &[f64], out_x: &mut [f64], out_y: &mut [f64]) {
    phase!("mercator::project");
    let n = xs.len().min(ys.len()).min(out_x.len()).min(out_y.len());
    for i in 0..n {
        let lat = ys[i];
        // `lat > MAX ? MAX : lat < -MAX ? -MAX : lat`, NaN included.
        let clamped = lat.clamp(-MAX_MERCATOR_LAT, MAX_MERCATOR_LAT);
        let sin = (clamped * DEG).sin();
        out_x[i] = MERCATOR_WORLD * (0.5 + xs[i] / 360.0);
        out_y[i] = MERCATOR_WORLD * (0.5 - ((1.0 + sin) / (1.0 - sin)).ln() * INV_4PI);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(lon: f64, lat: f64) -> (f64, f64) {
        let mut ox = [0.0];
        let mut oy = [0.0];
        project_mercator(&[lon], &[lat], &mut ox, &mut oy);
        (ox[0], oy[0])
    }

    #[test]
    fn origin_maps_to_world_centre() {
        assert_eq!(one(0.0, 0.0), (128.0, 128.0));
    }

    #[test]
    fn longitude_is_linear() {
        assert_eq!(one(-180.0, 0.0).0, 0.0);
        assert_eq!(one(180.0, 0.0).0, 256.0);
        assert_eq!(one(90.0, 0.0).0, 192.0);
    }

    #[test]
    fn latitude_is_clamped() {
        let (_, top) = one(0.0, 89.9);
        let (_, edge) = one(0.0, MAX_MERCATOR_LAT);
        assert_eq!(top, edge);
        assert!(top.abs() < 1e-6, "top of the world is y = 0, got {top}");
        let (_, bottom) = one(0.0, -90.0);
        assert!((bottom - 256.0).abs() < 1e-6);
    }

    #[test]
    fn nan_propagates_and_lengths_are_respected() {
        let (x, y) = one(f64::NAN, f64::NAN);
        assert!(x.is_nan() && y.is_nan());
        let mut ox = [7.0; 3];
        let mut oy = [7.0; 3];
        project_mercator(&[0.0, 0.0], &[0.0, 0.0], &mut ox, &mut oy);
        assert_eq!(ox, [128.0, 128.0, 7.0]);
        project_mercator(&[], &[], &mut [], &mut []);
    }
}
