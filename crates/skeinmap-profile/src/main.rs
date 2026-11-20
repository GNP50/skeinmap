//! Native spanscope harness for the skeinmap-wasm kernels.
//!
//! The kernel modules are compiled straight from `../skeinmap-wasm/src` (no copy), with
//! `phase!` defined as a spanscope span. Two modes:
//!
//! * `profile <n> [iterations] [out.json]` runs every kernel on the scene dumped by
//!   `dump-scene.mjs` (the inputs of `bench/run.mjs`) as traced roots and writes a
//!   spanscope profile;
//! * `digest <n>` runs every kernel over a matrix of zooms, cells and tolerances and
//!   prints one FNV-1a digest per kernel over the exact output bits, so an optimisation
//!   can be checked to change nothing.

use std::error::Error;
use std::fs;
use std::hint::black_box;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// One spanscope span until the end of the enclosing block.
macro_rules! phase {
    ($name:literal) => {
        let _phase = spanscope::span!($name);
    };
}

#[path = "../../skeinmap-wasm/src/cluster.rs"]
mod cluster;
#[path = "../../skeinmap-wasm/src/grid.rs"]
mod grid;
#[path = "../../skeinmap-wasm/src/lod.rs"]
mod lod;
#[path = "../../skeinmap-wasm/src/mercator.rs"]
mod mercator;
#[path = "../../skeinmap-wasm/src/simplify.rs"]
mod simplify;
#[path = "../../skeinmap-wasm/src/table.rs"]
mod table;

// ── Scene ─────────────────────────────────────────────────────────────────────

struct Scene {
    node_x: Vec<f64>,
    node_y: Vec<f64>,
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
    proj_x: Vec<f64>,
    proj_y: Vec<f64>,
    /// `[x0, y0, x1, y1]` per edge in projected pixels at zoom 6: the bounding box of a
    /// routed edge's points, NaN in slot 0 for a straight one (as the layer builds it).
    edge_box: Vec<f64>,
    win: grid::Window,
}

fn read_f64(dir: &Path, name: &str) -> Result<Vec<f64>, Box<dyn Error>> {
    let b = fs::read(dir.join(format!("{name}.f64")))?;
    Ok(b.chunks_exact(8)
        .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
        .collect())
}
fn read_u32(dir: &Path, name: &str) -> Result<Vec<u32>, Box<dyn Error>> {
    let b = fs::read(dir.join(format!("{name}.u32")))?;
    Ok(b.chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect())
}
fn read_u8(dir: &Path, name: &str) -> Result<Vec<u8>, Box<dyn Error>> {
    Ok(fs::read(dir.join(format!("{name}.u8")))?)
}

/// A number field of the flat `meta.json` written by `dump-scene.mjs`.
fn meta_number(meta: &str, key: &str) -> f64 {
    let at = meta.find(&format!("\"{key}\"")).expect(key) + key.len() + 3;
    let rest = meta[at..].trim_start_matches([' ', ':']);
    let end = rest.find([',', '\n', '}']).unwrap();
    rest[..end].trim().parse().expect(key)
}

fn load(n: usize) -> Result<Scene, Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/profile-data");
    let dir = root.join(n.to_string());
    let meta = fs::read_to_string(dir.join("meta.json"))
        .map_err(|e| format!("{}: {e} (run dump-scene.mjs first)", dir.display()))?;
    let win = grid::Window {
        x0: meta_number(&meta, "x0"),
        y0: meta_number(&meta, "y0"),
        x1: meta_number(&meta, "x1"),
        y1: meta_number(&meta, "y1"),
    };
    let path_start = read_u32(&dir, "path_start")?;
    let path_end = read_u32(&dir, "path_end")?;
    let unit_px = read_f64(&dir, "unit_px")?;
    let unit_py = read_f64(&dir, "unit_py")?;
    let mut edge_box = Vec::with_capacity(path_start.len() * 4);
    for (&s, &t) in path_start.iter().zip(&path_end) {
        if t - s >= 2 {
            let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for p in s as usize..t as usize {
                let (x, y) = (unit_px[p] * 64.0, unit_py[p] * 64.0);
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
            edge_box.extend_from_slice(&[x0, y0, x1, y1]);
        } else {
            edge_box.extend_from_slice(&[f64::NAN, 0.0, 0.0, 0.0]);
        }
    }
    Ok(Scene {
        node_x: read_f64(&dir, "node_x")?,
        node_y: read_f64(&dir, "node_y")?,
        unit_x: read_f64(&dir, "unit_x")?,
        unit_y: read_f64(&dir, "unit_y")?,
        node_style: read_u8(&dir, "node_style")?,
        edge_from: read_u32(&dir, "edge_from")?,
        edge_to: read_u32(&dir, "edge_to")?,
        edge_style: read_u8(&dir, "edge_style")?,
        path_start,
        path_end,
        unit_px,
        unit_py,
        proj_x: read_f64(&dir, "proj_x")?,
        proj_y: read_f64(&dir, "proj_y")?,
        edge_box,
        win,
    })
}

fn lod_geometry(s: &Scene) -> lod::Geometry {
    lod::Geometry::new(lod::GeometryInput {
        unit_x: s.unit_x.clone(),
        unit_y: s.unit_y.clone(),
        node_style: s.node_style.clone(),
        edge_from: s.edge_from.clone(),
        edge_to: s.edge_to.clone(),
        edge_style: s.edge_style.clone(),
        path_start: s.path_start.clone(),
        path_end: s.path_end.clone(),
        unit_px: s.unit_px.clone(),
        unit_py: s.unit_py.clone(),
        bounds: [0.0, 0.0, 256.0],
    })
}

fn path_set(s: &Scene) -> simplify::PathSet {
    simplify::PathSet::new(
        s.unit_px.clone(),
        s.unit_py.clone(),
        s.path_start.clone(),
        s.path_end.clone(),
    )
}

fn clusterer(s: &Scene) -> cluster::Clusterer {
    cluster::Clusterer::new(
        s.unit_x.clone(),
        s.unit_y.clone(),
        s.node_style.clone(),
        s.unit_x.len(),
        [0.0, 0.0, 256.0, 256.0],
    )
}

// ── Traced roots (the cases of bench/run.mjs) ─────────────────────────────────

#[spanscope::trace(root)]
fn root_mercator(s: &Scene, ox: &mut [f64], oy: &mut [f64]) {
    mercator::project_mercator(&s.node_x, &s.node_y, ox, oy);
}

#[spanscope::trace(root)]
fn root_lod_setup(s: &Scene) -> lod::Geometry {
    lod_geometry(s)
}

#[spanscope::trace(root)]
fn root_lod_level(g: &lod::Geometry, zoom: f64) -> lod::Level {
    spanscope::attribute!("zoom", zoom);
    g.level(zoom, 2.0)
}

#[spanscope::trace(root)]
fn root_grid(s: &Scene, boxes: bool) -> grid::Grid {
    spanscope::attribute!("edge_box", boxes);
    let edge_box: &[f64] = if boxes { &s.edge_box } else { &[] };
    grid::build_grid(
        s.unit_x.len(),
        &s.edge_from,
        &s.edge_to,
        &s.proj_x,
        &s.proj_y,
        edge_box,
        s.win,
        32.0,
    )
}

#[spanscope::trace(root)]
fn root_simplify_paths(s: &Scene, keep: &mut [u8]) {
    simplify::simplify_paths(
        &s.unit_px,
        &s.unit_py,
        &s.path_start,
        &s.path_end,
        0.5 / 256.0,
        keep,
    );
}

#[spanscope::trace(root)]
fn root_path_set_setup(s: &Scene) -> simplify::PathSet {
    path_set(s)
}

#[spanscope::trace(root)]
fn root_path_set_simplify(set: &simplify::PathSet) -> Vec<u8> {
    set.simplify(0.5 / 256.0)
}

#[spanscope::trace(root)]
fn root_cluster_setup(s: &Scene) -> cluster::Clusterer {
    clusterer(s)
}

#[spanscope::trace(root)]
fn root_cluster_level(c: &cluster::Clusterer) -> cluster::Level {
    c.level(6.0, 60.0)
}

fn profile(n: usize, iterations: usize, out: PathBuf) -> Result<(), Box<dyn Error>> {
    let s = load(n)?;
    spanscope::config::ConfigBuilder::new()
        .output(&out)
        .program("skeinmap-profile")
        .version(format!("n={n} iterations={iterations}"))
        .max_roots(100_000)
        .auto_flush(false)
        .init()?;
    let mut ox = vec![0.0; n];
    let mut oy = vec![0.0; n];
    let mut keep = vec![0u8; s.unit_px.len()];
    let g = lod_geometry(&s);
    let set = path_set(&s);
    let c = clusterer(&s);
    let t0 = Instant::now();
    let mut sink = 0usize;
    for _ in 0..iterations {
        root_mercator(&s, &mut ox, &mut oy);
        drop(black_box(root_lod_setup(&s)));
        for z in [4.0, 8.0] {
            sink += root_lod_level(&g, z).nodes.len();
        }
        sink += root_grid(&s, false).node_items.len();
        sink += root_grid(&s, true).edge_items.len();
        root_simplify_paths(&s, &mut keep);
        sink += root_path_set_setup(&s).lo() + usize::from(set.contiguous());
        sink += root_path_set_simplify(&set).len();
        drop(black_box(root_cluster_setup(&s)));
        sink += root_cluster_level(&c).count.len();
    }
    eprintln!(
        "profiled n={n} x{iterations} in {:.0} ms (checksum {sink})",
        t0.elapsed().as_secs_f64() * 1e3
    );
    spanscope::export::flush()?;
    eprintln!("wrote {}", out.display());
    Ok(())
}

// ── Output digests ────────────────────────────────────────────────────────────

struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    fn bytes(&mut self, b: &[u8]) {
        for &x in b {
            self.0 = (self.0 ^ u64::from(x)).wrapping_mul(0x100_0000_01b3);
        }
    }
    fn len(&mut self, n: usize) {
        self.bytes(&(n as u64).to_le_bytes());
    }
    fn f64s(&mut self, v: &[f64]) {
        self.len(v.len());
        for x in v {
            self.bytes(&x.to_bits().to_le_bytes());
        }
    }
    fn u32s(&mut self, v: &[u32]) {
        self.len(v.len());
        for x in v {
            self.bytes(&x.to_le_bytes());
        }
    }
    fn i32s(&mut self, v: &[i32]) {
        self.len(v.len());
        for x in v {
            self.bytes(&x.to_le_bytes());
        }
    }
}

fn digest(n: usize) -> Result<(), Box<dyn Error>> {
    let s = load(n)?;
    let zooms = [-1.0, 0.0, 2.0, 3.5, 4.0, 6.0, 8.0, 10.0, 12.0, 16.0];

    let mut h = Fnv::new();
    let mut ox = vec![0.0; n];
    let mut oy = vec![0.0; n];
    mercator::project_mercator(&s.node_x, &s.node_y, &mut ox, &mut oy);
    h.f64s(&ox);
    h.f64s(&oy);
    println!("mercator         {:016x}", h.0);

    let mut h = Fnv::new();
    let g = lod_geometry(&s);
    for z in zooms {
        for cell in [2.0, 7.0] {
            let l = g.level(z, cell);
            h.u32s(&l.nodes);
            h.u32s(&l.seg_edge);
            h.i32s(&l.seg_p0);
            h.i32s(&l.seg_p1);
        }
    }
    println!("lod              {:016x}", h.0);

    let mut h = Fnv::new();
    for boxes in [false, true] {
        for cell in [8.0, 32.0, 100.0] {
            let edge_box: &[f64] = if boxes { &s.edge_box } else { &[] };
            let gr = grid::build_grid(
                n,
                &s.edge_from,
                &s.edge_to,
                &s.proj_x,
                &s.proj_y,
                edge_box,
                s.win,
                cell,
            );
            h.u32s(&[gr.cols, gr.rows]);
            h.u32s(&gr.node_start);
            h.u32s(&gr.node_items);
            h.u32s(&gr.edge_start);
            h.u32s(&gr.edge_items);
            h.u32s(&gr.long_edges);
        }
    }
    println!("grid             {:016x}", h.0);

    let mut h = Fnv::new();
    let set = path_set(&s);
    for z in zooms {
        let tol = 0.5 / lod::pow2(z);
        let mut keep = vec![7u8; s.unit_px.len()];
        simplify::simplify_paths(&s.unit_px, &s.unit_py, &s.path_start, &s.path_end, tol, &mut keep);
        h.bytes(&keep);
        h.bytes(&set.simplify(tol));
        let mut keep = vec![7u8; s.unit_px.len()];
        set.simplify_into(tol, &mut keep);
        h.bytes(&keep);
    }
    println!("simplify         {:016x}", h.0);

    let mut h = Fnv::new();
    let c = clusterer(&s);
    for z in zooms {
        for cell in [20.0, 60.0] {
            let l = c.level(z, cell);
            h.u32s(&l.cluster_of);
            h.f64s(&l.x);
            h.f64s(&l.y);
            h.u32s(&l.count);
        }
    }
    println!("cluster          {:016x}", h.0);
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let usage = "usage: skeinmap-profile profile <n> [iterations] [out.json] | digest <n>";
    let n: usize = args.get(1).ok_or(usage)?.parse()?;
    match args[0].as_str() {
        "profile" => {
            let iterations = args.get(2).map_or(Ok(10), |a| a.parse())?;
            let out = args
                .get(3)
                .map_or_else(|| PathBuf::from(format!("profile-{n}.json")), PathBuf::from);
            profile(n, iterations, out)
        }
        "digest" => digest(n),
        _ => Err(usage.into()),
    }
}
