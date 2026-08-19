/**
 * Tile-grid and base-crop geometry behind the detail patches.
 *
 * Both of these get the antimeridian wrong in the obvious implementation, and
 * both fail silently when they do — a patch over Fiji just quietly draws the
 * wrong half of the planet — so they are pinned here.
 */
import { describe, it, expect } from 'vitest';
import {
  baseCropSlices,
  eachTile,
  patchReuse,
  planDetail,
  tileRect,
  type PatchBounds,
  type TileRect,
} from '../src/globe/globe';

/** Every (row, col) a rect resolves to, in order. */
function tilesOf(rect: TileRect): [number, number][] {
  const out: [number, number][] = [];
  eachTile(rect, (row, col) => out.push([row, col]));
  return out;
}

describe('tileRect', () => {
  it('covers the requested box at the requested level', () => {
    // z=4 → 11.25° tiles, 32 columns × 16 rows over the WGS84 grid.
    const r = tileRect(4, 0, 0, 20, 20);
    expect(r.z).toBe(4);
    // ±20° of a 11.25° grid spans 4 tiles each way.
    expect(r.cols).toBe(4);
    expect(r.rows).toBe(4);
    expect(tilesOf(r)).toHaveLength(16);
  });

  it('clamps rows at the poles instead of running off the grid', () => {
    const r = tileRect(4, 0, 88, 10, 10);
    expect(r.rowStart).toBe(0);
    for (const [row] of tilesOf(r)) {
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(2 ** 4);
    }
  });

  it('wraps columns across the antimeridian', () => {
    const r = tileRect(4, 178, 0, 10, 5); // straddles 180°
    const cols = tilesOf(r).map(([, col]) => col);
    const nCols = 2 ** 5;
    for (const col of cols) {
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(nCols);
    }
    // The run has to touch both edges of the grid — that is the wrap.
    expect(cols).toContain(nCols - 1);
    expect(cols).toContain(0);
  });
});

describe('baseCropSlices', () => {
  it('is a single slice when the patch does not cross the seam', () => {
    const slices = baseCropSlices(-10, 20, 800);
    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ srcLon: -10, spanDeg: 20, dx: 0, dw: 800 });
  });

  it('splits at the seam and lands the pieces edge to edge', () => {
    // 170°E → 190°E, i.e. 10° short of the seam and 10° past it.
    const slices = baseCropSlices(170, 20, 800);
    expect(slices).toHaveLength(2);
    expect(slices[0]).toMatchObject({ srcLon: 170, spanDeg: 10, dx: 0, dw: 400 });
    expect(slices[1]).toMatchObject({ srcLon: -180, spanDeg: 10, dx: 400, dw: 400 });
  });

  it('covers the whole destination width, whatever the split', () => {
    for (const lonMin of [-200, -180, -37, 0, 91, 175, 180, 350]) {
      const slices = baseCropSlices(lonMin, 45, 1024);
      const covered = slices.reduce((sum, s) => sum + s.dw, 0);
      expect(covered).toBeCloseTo(1024, 6);
      const degrees = slices.reduce((sum, s) => sum + s.spanDeg, 0);
      expect(degrees).toBeCloseTo(45, 9);
      // No slice may read past the right edge of the source image.
      for (const s of slices) expect(s.srcLon + s.spanDeg).toBeLessThanOrEqual(180 + 1e-9);
    }
  });

  it('terminates on a patch that spans the entire globe', () => {
    const slices = baseCropSlices(-180, 360, 512);
    expect(slices.reduce((sum, s) => sum + s.dw, 0)).toBeCloseTo(512, 6);
  });
});

describe('planDetail zoom bands', () => {
  /** The plans a zoom sweep produces at a fixed centre, coarsest first. */
  function sweep(w: number, h: number, dpr: number, lon = 12, lat = 31) {
    const baseScale = Math.min(w, h) / 2 - 12;
    const out = [];
    for (let zoom = 2.2; zoom <= 48; zoom *= 1.04) {
      const pxPerDeg = ((baseScale * zoom) * Math.PI) / 180;
      const plan = planDetail(lon, lat, pxPerDeg * dpr, w / pxPerDeg, h / pxPerDeg);
      if (plan) out.push(plan);
    }
    return out;
  }

  /**
   * The warming passes lean on this: a patch level owns a contiguous band of
   * zoom, and the band opens at its widest. Warm that one rect and every plan
   * in the band is a cache hit. If levels ever interleaved, or a rect grew as
   * you zoomed in, warming would silently start missing.
   */
  it('opens each level at its widest rect and only narrows from there', () => {
    for (const [w, h, dpr] of [[900, 740, 1], [900, 740, 2], [390, 720, 3], [1600, 900, 1]]) {
      const plans = sweep(w, h, dpr);
      expect(plans.length).toBeGreaterThan(10);
      const opening = new Map<number, (typeof plans)[number]>();
      let deepest = -1;
      for (const plan of plans) {
        expect(plan.z).toBeGreaterThanOrEqual(deepest); // levels never go back up
        if (plan.z > deepest) {
          deepest = plan.z;
          opening.set(plan.z, plan);
          continue;
        }
        // Same band: this rect must sit inside the one the band opened with.
        const first = opening.get(plan.z)!;
        expect(plan.colStart).toBeGreaterThanOrEqual(first.colStart);
        expect(plan.rowStart).toBeGreaterThanOrEqual(first.rowStart);
        expect(plan.colStart + plan.cols).toBeLessThanOrEqual(first.colStart + first.cols);
        expect(plan.rowStart + plan.rows).toBeLessThanOrEqual(first.rowStart + first.rows);
      }
    }
  });

  it('never plans a patch larger than one texture upload', () => {
    for (const plan of sweep(1600, 900, 2)) {
      expect(plan.cols).toBeLessThanOrEqual(8);
      expect(plan.rows).toBeLessThanOrEqual(8);
    }
  });
});

describe('patchReuse', () => {
  /** A square patch, `span` degrees on a side, with its top-left at (lon, lat). */
  const box = (lon: number, lat: number, span: number): PatchBounds => ({
    lonMin: lon,
    latMax: lat,
    lonSpan: span,
    latSpan: span,
  });

  it('maps a patch onto itself as the whole canvas', () => {
    const b = box(-10, 40, 20);
    const r = patchReuse(b, 512, 512, b, 1024, 1024)!;
    expect(r).toMatchObject({ sx: 0, sy: 0, sw: 512, sh: 512, dx: 0, dy: 0, dw: 1024, dh: 1024 });
  });

  it('places a zoomed-in patch inside its predecessor', () => {
    // The new patch is the middle quarter of the old one, at twice the pixels.
    const prev = box(-20, 50, 40);
    const next = box(-10, 40, 20);
    const r = patchReuse(prev, 800, 800, next, 800, 800)!;
    // Source: the centre 20x20 degrees of an 800px, 40-degree canvas.
    expect(r).toMatchObject({ sx: 200, sy: 200, sw: 400, sh: 400 });
    // Destination: all of it, upscaled.
    expect(r).toMatchObject({ dx: 0, dy: 0, dw: 800, dh: 800 });
  });

  it('places a zoomed-out patch as an island in the middle of the new one', () => {
    const prev = box(-10, 40, 20);
    const next = box(-20, 50, 40);
    const r = patchReuse(prev, 800, 800, next, 800, 800)!;
    expect(r).toMatchObject({ sx: 0, sy: 0, sw: 800, sh: 800 });
    expect(r).toMatchObject({ dx: 200, dy: 200, dw: 400, dh: 400 });
  });

  it('clips a patch that only partly overlaps', () => {
    const prev = box(0, 20, 20); // 0..20 E, 0..20 N
    const next = box(10, 30, 20); // 10..30 E, 10..30 N
    const r = patchReuse(prev, 400, 400, next, 400, 400)!;
    // Common ground is 10..20 E by 10..20 N — a quarter of each.
    expect(r).toMatchObject({ sx: 200, sy: 0, sw: 200, sh: 200 });
    expect(r).toMatchObject({ dx: 0, dy: 200, dw: 200, dh: 200 });
  });

  it('recognises the same ground written in a different turn of longitude', () => {
    // 190E and -170E are the same meridian; a patch that crossed the
    // antimeridian carries the first spelling and its successor the second.
    const prev = box(185, 10, 20); // 185..205 E
    const next = box(-170, 10, 20); // = 190..210 E
    const r = patchReuse(prev, 400, 400, next, 400, 400)!;
    // Overlap is 190..205 E: three quarters of each, off opposite edges.
    expect(r.sx).toBeCloseTo(100, 6);
    expect(r.sw).toBeCloseTo(300, 6);
    expect(r.dx).toBeCloseTo(0, 6);
    expect(r.dw).toBeCloseTo(300, 6);
  });

  it('is null when the two patches share no ground', () => {
    expect(patchReuse(box(-100, 40, 10), 256, 256, box(20, 40, 10), 256, 256)).toBeNull();
    expect(patchReuse(box(0, 80, 10), 256, 256, box(0, 20, 10), 256, 256)).toBeNull();
  });

  it('never reads or writes outside either canvas', () => {
    const prev = box(-30, 60, 40);
    for (const lon of [-200, -60, -35, -10, 0, 150, 330]) {
      for (const lat of [90, 55, 30, -10]) {
        const r = patchReuse(prev, 1024, 1024, box(lon, lat, 25), 512, 512);
        if (!r) continue;
        expect(r.sx).toBeGreaterThanOrEqual(0);
        expect(r.sy).toBeGreaterThanOrEqual(0);
        expect(r.sx + r.sw).toBeLessThanOrEqual(1024 + 1e-9);
        expect(r.sy + r.sh).toBeLessThanOrEqual(1024 + 1e-9);
        expect(r.dx).toBeGreaterThanOrEqual(0);
        expect(r.dy).toBeGreaterThanOrEqual(0);
        expect(r.dx + r.dw).toBeLessThanOrEqual(512 + 1e-9);
        expect(r.dy + r.dh).toBeLessThanOrEqual(512 + 1e-9);
      }
    }
  });
});

describe('patchReuse alignment', () => {
  /** Canvas size a plan's patch gets, in pixels. */
  const size = (p: { cols: number; rows: number }): [number, number] => [p.cols * 256, p.rows * 256];

  it('blits patch to patch at whole pixels and a power-of-two scale', () => {
    // Every patch is tile-aligned on the same global grid, so carrying one
    // patch's pixels into the next lands on whole pixels at a power-of-two
    // scale. That is what lets a patch be seeded from its predecessor over and
    // over — through a long zoom, or through a drag that re-plans twice a
    // second — without the imagery going soft from repeated interpolation:
    // there is no sub-pixel phase for the resampler to smear.
    //
    // Whole pixels, not whole tiles. Crossing a tile level halves the source
    // grid against the destination, so an offset of half a source tile (128 px)
    // is normal and exact; only within a level is everything a multiple of 256.
    for (const [lon, lat] of [[-98, 39], [139, 35], [-43, -22], [18, 59]]) {
      let prev = null as ReturnType<typeof planDetail>;
      for (let zoom = 2.2; zoom <= 48; zoom *= 1.07) {
        const scalePx = 338 * zoom;
        const pxPerDeg = (scalePx * Math.PI) / 180;
        const plan = planDetail(lon, lat, pxPerDeg, 900 / pxPerDeg, 700 / pxPerDeg);
        if (!plan) continue;
        if (prev) {
          const [pw, ph] = size(prev);
          const [nw, nh] = size(plan);
          const r = patchReuse(prev.bounds, pw, ph, plan.bounds, nw, nh);
          expect(r).not.toBeNull();
          for (const v of [r!.sx, r!.sy, r!.dx, r!.dy, r!.sw, r!.sh, r!.dw, r!.dh]) {
            expect(v).toBe(Math.round(v));
          }
          // Scale is a power of two: same tile level is 1:1, one level in is 2x.
          const scaleX = r!.dw / r!.sw;
          expect(Math.log2(scaleX)).toBeCloseTo(Math.round(Math.log2(scaleX)), 6);
          expect(r!.dh / r!.sh).toBeCloseTo(scaleX, 6);
        }
        prev = plan;
      }
    }
  });

  it('blits on tile boundaries when the view pans, too', () => {
    // Panning holds the tile level and shifts the rect by whole tiles, so the
    // carried-over pixels move by whole tiles as well: a pure integer copy.
    const pxPerDeg = (338 * 8 * Math.PI) / 180;
    const plan = (lon: number, lat: number) =>
      planDetail(lon, lat, pxPerDeg, 900 / pxPerDeg, 700 / pxPerDeg)!;
    let prev = plan(-98, 39);
    for (let i = 1; i <= 30; i++) {
      const next = plan(-98 + i * 1.5, 39 + i * 0.8);
      if (next.z !== prev.z) { prev = next; continue; }
      const r = patchReuse(prev.bounds, prev.cols * 256, prev.rows * 256,
                           next.bounds, next.cols * 256, next.rows * 256);
      if (r) {
        expect(r.dw).toBeCloseTo(r.sw, 6); // 1:1 — no scaling at all
        expect(r.dh).toBeCloseTo(r.sh, 6);
        for (const v of [r.sx, r.sy, r.dx, r.dy]) expect(v % 256).toBeCloseTo(0, 6);
      }
      prev = next;
    }
  });
});
