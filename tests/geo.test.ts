import { describe, it, expect } from 'vitest';
import {
  haversineKm,
  scoreForDistance,
  scoreEmoji,
  formatKm,
  formatMiles,
  formatDistance,
  grade,
  ANTIPODAL_KM,
  BULLSEYE_KM,
  KM_PER_MILE,
  MAX_SCORE,
} from '../src/core/geo';

describe('haversineKm', () => {
  it('is zero for identical points', () => {
    expect(haversineKm({ lat: 48.86, lon: 2.35 }, { lat: 48.86, lon: 2.35 })).toBe(0);
  });

  it('matches known distance Paris → London (~344 km)', () => {
    const d = haversineKm({ lat: 48.857, lon: 2.352 }, { lat: 51.507, lon: -0.128 });
    expect(d).toBeGreaterThan(330);
    expect(d).toBeLessThan(360);
  });

  it('matches known distance NYC → Sydney (~15,990 km)', () => {
    const d = haversineKm({ lat: 40.713, lon: -74.006 }, { lat: -33.869, lon: 151.209 });
    expect(d).toBeGreaterThan(15500);
    expect(d).toBeLessThan(16500);
  });

  it('handles the antimeridian (Suva → Nukuʻalofa is short, not half the planet)', () => {
    const d = haversineKm({ lat: -18.141, lon: 178.442 }, { lat: -21.139, lon: -175.204 });
    expect(d).toBeLessThan(800);
  });

  it('is symmetric', () => {
    const a = { lat: 35.68, lon: 139.69 };
    const b = { lat: -33.87, lon: 151.21 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 6);
  });
});

describe('scoreForDistance', () => {
  it('gives max score inside the bullseye', () => {
    expect(scoreForDistance(0)).toBe(MAX_SCORE);
    expect(scoreForDistance(BULLSEYE_KM - 1)).toBe(MAX_SCORE);
  });

  it('is monotonically non-increasing', () => {
    let prev = MAX_SCORE;
    for (const km of [20, 50, 100, 200, 400, 800, 1200, 5000, 20000]) {
      const s = scoreForDistance(km);
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
  });

  // THE anchors: real MapTap rounds, read off the game's own reveal screen.
  // The two modern ones (same build, same day) are what the curve is fitted
  // to — one parameter, both reproduced exactly.
  it('reproduces the measured MapTap rounds', () => {
    expect(scoreForDistance(3820)).toBe(58); // Santa Monica
    expect(scoreForDistance(13060)).toBe(6); // Nicosia
  });

  it('matches the curve at its reference distances', () => {
    expect(scoreForDistance(500)).toBe(94);
    expect(scoreForDistance(1000)).toBe(88);
    expect(scoreForDistance(2000)).toBe(76);
    expect(scoreForDistance(5000)).toBe(47);
    expect(scoreForDistance(8000)).toBe(27);
    expect(scoreForDistance(15000)).toBe(3);
  });

  it('is forgiving — MapTap does not punish country-scale misses', () => {
    // A miss the width of Germany barely dents the score…
    expect(scoreForDistance(400)).toBeGreaterThanOrEqual(94);
    // …and coast-to-coast across the USA is still a pass mark.
    expect(scoreForDistance(4000)).toBeGreaterThan(55);
  });

  it('makes zero reachable, but only from most of a planet away', () => {
    // Players do post zeroes, so the curve has to bottom out inside the
    // range of real misses — but not before a genuinely catastrophic one.
    expect(scoreForDistance(13000)).toBeGreaterThan(0);
    expect(scoreForDistance(17410)).toBe(0);
  });

  it('bottoms out exactly at the antipode and stays there', () => {
    expect(scoreForDistance(ANTIPODAL_KM)).toBe(0);
    expect(scoreForDistance(ANTIPODAL_KM + 5000)).toBe(0);
  });

  it('has a bullseye that falls out of the curve rather than being bolted on', () => {
    // ~5–11% of real rounds score exactly 100, which needs a radius of
    // tens of km — the exponent produces one without a piecewise branch.
    expect(BULLSEYE_KM).toBeGreaterThan(25);
    expect(BULLSEYE_KM).toBeLessThan(55);
    expect(scoreForDistance(BULLSEYE_KM - 1)).toBe(MAX_SCORE);
    expect(scoreForDistance(BULLSEYE_KM + 1)).toBeLessThan(MAX_SCORE);
  });

  it('never goes below zero or above max', () => {
    expect(scoreForDistance(1e9)).toBeGreaterThanOrEqual(0);
    expect(scoreForDistance(-5)).toBe(0);
    expect(scoreForDistance(NaN)).toBe(0);
    expect(scoreForDistance(Infinity)).toBe(0);
  });
});

describe('scoreEmoji', () => {
  it('picks from the band the score falls in', () => {
    expect(['🎯', '🔥', '💯', '🏅', '🥇']).toContain(scoreEmoji(100));
    expect(['🎯', '🔥', '💯', '🏅', '🥇']).toContain(scoreEmoji(95));
    expect(['🏆', '👑', '🥈', '🎉']).toContain(scoreEmoji(90));
    expect(['😱', '🤢', '😭']).toContain(scoreEmoji(0));
  });

  it('always returns something, at every score', () => {
    for (let s = 0; s <= 100; s++) expect(scoreEmoji(s)).toBeTruthy();
  });

  it('is deterministic given a fixed sampler', () => {
    expect(scoreEmoji(100, () => 0)).toBe('🎯');
  });
});

describe('formatKm', () => {
  it('formats sub-km, precise, and large distances', () => {
    expect(formatKm(0.4)).toBe('<1 km');
    expect(formatKm(42.31)).toBe('42.3 km');
    expect(formatKm(1234.6)).toBe('1,235 km');
  });
});

describe('formatMiles', () => {
  it('converts and formats the way MapTap reports errors', () => {
    expect(formatMiles(0.5)).toBe('<1 mi');
    expect(formatMiles(80.4672)).toBe('50.0 mi');
    expect(formatMiles(225 * KM_PER_MILE)).toBe('225 mi');
  });

  it('pairs both units for the reveal', () => {
    expect(formatDistance(225 * KM_PER_MILE)).toBe('362 km · 225 mi');
  });
});

describe('grade', () => {
  it('maps averages to the ladder', () => {
    expect(grade(99)).toBe('GOAT');
    expect(grade(92)).toBe('S');
    expect(grade(85)).toBe('A');
    expect(grade(70)).toBe('B');
    expect(grade(55)).toBe('C');
    expect(grade(35)).toBe('D');
    expect(grade(5)).toBe('F');
  });
});
