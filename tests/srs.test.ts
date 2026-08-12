import { describe, it, expect } from 'vitest';
import {
  updateStat,
  selectionWeight,
  pickWeighted,
  weakestLocations,
  type StatsMap,
} from '../src/core/srs';
import type { Location } from '../src/data/types';

const NOW = 1_700_000_000_000;

const loc = (id: string): Location => ({
  id,
  name: id,
  country: 'X',
  lat: 0,
  lon: 0,
  tier: 1,
  continent: 'europe',
  tags: ['capital'],
});

describe('updateStat', () => {
  it('initializes on first attempt', () => {
    const s = updateStat(undefined, 80, 120, NOW);
    expect(s.attempts).toBe(1);
    expect(s.emaScore).toBe(80);
    expect(s.emaErrorKm).toBe(120);
    expect(s.bestKm).toBe(120);
  });

  it('moves the EMA toward new results and tracks best', () => {
    let s = updateStat(undefined, 100, 5, NOW);
    s = updateStat(s, 0, 2000, NOW + 1);
    expect(s.attempts).toBe(2);
    expect(s.emaScore).toBeLessThan(100);
    expect(s.emaScore).toBeGreaterThan(0);
    expect(s.bestKm).toBe(5);
  });
});

describe('selectionWeight', () => {
  it('gives unseen locations an exploration bonus', () => {
    expect(selectionWeight(undefined, NOW)).toBeGreaterThan(1);
  });

  it('weights weak locations above mastered ones', () => {
    const weak = updateStat(undefined, 10, 3000, NOW);
    const strong = updateStat(undefined, 98, 8, NOW);
    expect(selectionWeight(weak, NOW)).toBeGreaterThan(selectionWeight(strong, NOW));
  });

  it('increases weight with staleness', () => {
    const fresh = updateStat(undefined, 90, 30, NOW);
    const stale = updateStat(undefined, 90, 30, NOW - 10 * 86_400_000);
    expect(selectionWeight(stale, NOW)).toBeGreaterThan(selectionWeight(fresh, NOW));
  });
});

describe('pickWeighted', () => {
  const pool = ['a', 'b', 'c', 'd', 'e'].map(loc);

  it('returns distinct locations of the requested count', () => {
    const picked = pickWeighted(pool, {}, 3, NOW, () => 0.5);
    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((l) => l.id)).size).toBe(3);
  });

  it('never exceeds the pool size', () => {
    expect(pickWeighted(pool, {}, 99, NOW)).toHaveLength(5);
  });

  it('strongly favors weak locations over mastered ones', () => {
    const statsMap: StatsMap = {};
    for (const l of pool) statsMap[l.id] = updateStat(undefined, 100, 1, NOW);
    statsMap['c'] = updateStat(undefined, 0, 5000, NOW); // one disaster spot
    let cFirst = 0;
    const trials = 500;
    let seed = 42;
    const rng = (): number => {
      // deterministic LCG
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < trials; i++) {
      if (pickWeighted(pool, statsMap, 1, NOW, rng)[0].id === 'c') cFirst++;
    }
    // 'c' has weight ~2.1 vs ~0.1 each for the rest → should dominate
    expect(cFirst / trials).toBeGreaterThan(0.6);
  });
});

describe('weakestLocations', () => {
  it('returns attempted locations sorted by ascending skill', () => {
    const pool = ['a', 'b', 'c'].map(loc);
    const statsMap: StatsMap = {
      a: updateStat(undefined, 90, 20, NOW),
      c: updateStat(undefined, 10, 4000, NOW),
    };
    const weakest = weakestLocations(pool, statsMap, 5);
    expect(weakest.map((l) => l.id)).toEqual(['c', 'a']); // b never attempted
  });
});
