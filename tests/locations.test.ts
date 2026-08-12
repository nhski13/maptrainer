import { describe, it, expect } from 'vitest';
import { LOCATIONS } from '../src/data/locations';
import { haversineKm } from '../src/core/geo';

describe('location dataset integrity', () => {
  it('has a substantial corpus', () => {
    expect(LOCATIONS.length).toBeGreaterThanOrEqual(230);
  });

  it('has unique ids', () => {
    const ids = LOCATIONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has valid coordinates', () => {
    for (const l of LOCATIONS) {
      expect(l.lat, l.id).toBeGreaterThanOrEqual(-90);
      expect(l.lat, l.id).toBeLessThanOrEqual(90);
      expect(l.lon, l.id).toBeGreaterThanOrEqual(-180);
      expect(l.lon, l.id).toBeLessThanOrEqual(180);
    }
  });

  it('has no two locations implausibly close (dup coordinates)', () => {
    for (let i = 0; i < LOCATIONS.length; i++) {
      for (let j = i + 1; j < LOCATIONS.length; j++) {
        const d = haversineKm(LOCATIONS[i], LOCATIONS[j]);
        expect(
          d,
          `${LOCATIONS[i].id} vs ${LOCATIONS[j].id} are ${d.toFixed(1)} km apart`,
        ).toBeGreaterThan(1);
      }
    }
  });

  it('covers all 50 US states', () => {
    expect(LOCATIONS.filter((l) => l.tags.includes('us-state'))).toHaveLength(50);
  });

  it('spot-checks famous coordinates', () => {
    const tokyo = LOCATIONS.find((l) => l.id === 'tokyo')!;
    expect(haversineKm(tokyo, { lat: 35.6762, lon: 139.6503 })).toBeLessThan(15);
    const paris = LOCATIONS.find((l) => l.id === 'paris')!;
    expect(haversineKm(paris, { lat: 48.8566, lon: 2.3522 })).toBeLessThan(15);
    const dc = LOCATIONS.find((l) => l.id === 'washington-dc')!;
    expect(haversineKm(dc, { lat: 38.9072, lon: -77.0369 })).toBeLessThan(15);
  });
});
