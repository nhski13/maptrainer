/**
 * The pre-built state mesh in src/data/state-lines.ts.
 *
 * It is generated, delta-encoded and never read by a human, so the things that
 * would go wrong with it are the things a decoder bug does quietly: arcs that
 * drift a continent away, a cap that no longer contains what it claims to, or
 * a regeneration that silently pulled in the coastlines the mesh exists to
 * leave out. None of those throw — they just draw wrong.
 */
import { describe, it, expect } from 'vitest';
import { geoDistance } from 'd3-geo';
import { stateLines, stateLinesCap } from '../src/data/state-lines';

const pts = stateLines.coordinates.flat();

describe('state-lines data', () => {
  it('decodes to well-formed GeoJSON', () => {
    expect(stateLines.type).toBe('MultiLineString');
    expect(stateLines.coordinates.length).toBeGreaterThan(40);
    for (const line of stateLines.coordinates) {
      expect(line.length).toBeGreaterThanOrEqual(2); // a point is not a line
      for (const [lon, lat] of line) {
        expect(Number.isFinite(lon)).toBe(true);
        expect(Number.isFinite(lat)).toBe(true);
      }
    }
  });

  it('is the lower 48 and nothing else', () => {
    // Interior boundaries only: no state line reaches Alaska, Hawaii, the
    // Canadian border west of the lakes, or the Atlantic and Pacific coasts.
    const lons = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    expect(Math.min(...lons)).toBeGreaterThan(-125); // no Alaska (-179), no Hawaii (-160)
    expect(Math.max(...lons)).toBeLessThan(-66);
    expect(Math.min(...lats)).toBeGreaterThan(24); // no Florida Keys, no Puerto Rico
    expect(Math.max(...lats)).toBeLessThan(50);
  });

  it('has a cap that actually contains the mesh', () => {
    // The renderer skips the whole path on this bound, so a cap that is even
    // slightly too small clips state lines off the edge of the visible disc.
    for (const p of pts) {
      expect(geoDistance(stateLinesCap.center, p)).toBeLessThanOrEqual(stateLinesCap.radius);
    }
    // …and one that is far too large would defeat the point of having it.
    expect(stateLinesCap.radius).toBeLessThan(0.45); // ~26 degrees
  });

  it('places the well-known boundaries where they belong', () => {
    /**
     * Distance in km to the nearest point *on* the mesh — segments, not
     * vertices. A boundary that runs straight for 300 km, as several western
     * ones do, carries no vertices in between, so measuring to the nearest
     * vertex would report a place sitting exactly on the line as tens of
     * kilometres off it.
     */
    const missKm = (lon: number, lat: number): number => {
      const kx = Math.cos((lat * Math.PI) / 180) * 111.32; // km per degree lon
      const ky = 110.57; // km per degree lat
      let best = Infinity;
      for (const line of stateLines.coordinates) {
        for (let i = 1; i < line.length; i++) {
          const ax = (line[i - 1][0] - lon) * kx;
          const ay = (line[i - 1][1] - lat) * ky;
          const bx = (line[i][0] - lon) * kx;
          const by = (line[i][1] - lat) * ky;
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy;
          // Foot of the perpendicular, clamped to the segment's endpoints.
          const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
          best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
        }
      }
      return best;
    };
    // Four Corners, where Utah, Colorado, Arizona and New Mexico meet.
    expect(missKm(-109.045, 36.999)).toBeLessThan(2);
    // The Mississippi at Memphis — the Tennessee/Arkansas line.
    expect(missKm(-90.13, 35.12)).toBeLessThan(5);
    // Lake Tahoe, on the California/Nevada line.
    expect(missKm(-120.0, 39.1)).toBeLessThan(5);
    // The Ohio at Cincinnati — the Ohio/Kentucky line.
    expect(missKm(-84.51, 39.09)).toBeLessThan(3);
    // Mid-Atlantic, off Cape Hatteras: ocean, and no state line runs there.
    expect(missKm(-70.0, 34.0)).toBeGreaterThan(200);
  });
});
