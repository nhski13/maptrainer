import { describe, it, expect } from 'vitest';
import {
  haversineKm,
  scoreForDistance,
  scoreEmoji,
  formatKm,
  grade,
  BULLSEYE_KM,
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
    expect(scoreForDistance(BULLSEYE_KM)).toBe(MAX_SCORE);
  });

  it('is monotonically non-increasing', () => {
    let prev = MAX_SCORE;
    for (const km of [20, 50, 100, 200, 400, 800, 1200, 5000, 20000]) {
      const s = scoreForDistance(km);
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
  });

  it('matches the calibrated MapTap curve at its reference distances', () => {
    // Fitted to the score distribution of 2,240 real MapTap rounds.
    expect(scoreForDistance(50)).toBe(96);
    expect(scoreForDistance(100)).toBe(91);
    expect(scoreForDistance(250)).toBe(80);
    expect(scoreForDistance(500)).toBe(67);
    expect(scoreForDistance(1000)).toBe(48);
    expect(scoreForDistance(2000)).toBe(26);
    expect(scoreForDistance(5000)).toBe(5);
  });

  it('keeps a fat tail — a wrong-continent miss still scores, an antipodal one does not', () => {
    // The old exp(-d/400) curve was already at ~0 by 1,200 km, which cannot
    // produce the 10–45 band that ~15% of real MapTap rounds land in.
    expect(scoreForDistance(1500)).toBeGreaterThan(30);
    expect(scoreForDistance(3000)).toBeGreaterThan(10);
    expect(scoreForDistance(12000)).toBe(0);
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
