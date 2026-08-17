/**
 * Tile-grid and base-crop geometry behind the detail patches.
 *
 * Both of these get the antimeridian wrong in the obvious implementation, and
 * both fail silently when they do — a patch over Fiji just quietly draws the
 * wrong half of the planet — so they are pinned here.
 */
import { describe, it, expect } from 'vitest';
import { baseCropSlices, eachTile, planDetail, tileRect, type TileRect } from '../src/globe/globe';

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
