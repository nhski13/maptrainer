/**
 * The population column and how it is written out.
 *
 * The data is generated (scripts/backfill-populations.mjs) and the formatter
 * rounds, so both can go quietly wrong: a gazetteer refresh could drop entries
 * or land a district total on a village, and the formatter has two threshold
 * crossings where a naive round prints "1000k" or "10.0M".
 */
import { describe, it, expect } from 'vitest';
import { formatPopulation } from '../src/core/geo';
import { LOCATIONS } from '../src/data/locations';
import { PACK_CITIES } from '../src/data/cities';

describe('formatPopulation', () => {
  it('reads at two significant figures above a million', () => {
    expect(formatPopulation(1_275_857)).toBe('1.3M');
    expect(formatPopulation(8_336_599)).toBe('8.3M');
    expect(formatPopulation(22_006_299)).toBe('22M');
  });

  it('reads in thousands between ten thousand and a million', () => {
    expect(formatPopulation(200_602)).toBe('201k');
    expect(formatPopulation(10_000)).toBe('10k');
    expect(formatPopulation(32_756)).toBe('33k');
  });

  it('prints small towns exactly', () => {
    expect(formatPopulation(8_342)).toMatch(/^8.342$/); // separator is the locale's
    expect(formatPopulation(9_999)).toMatch(/^9.999$/);
  });

  it('never prints a rounded figure that should have crossed a threshold', () => {
    expect(formatPopulation(999_999)).toBe('1.0M'); // not "1000k"
    expect(formatPopulation(999_500)).toBe('1.0M');
    expect(formatPopulation(9_999_999)).toBe('10M'); // not "10.0M"
    expect(formatPopulation(9_950_000)).toBe('10M');
    expect(formatPopulation(9_940_000)).toBe('9.9M');
    // Whatever the input, the output is short enough to sit on the card.
    for (let p = 1; p < 40_000_000; p = Math.ceil(p * 1.07)) {
      expect(formatPopulation(p)).not.toMatch(/1000k|\d\d\.\dM/);
    }
  });
});

describe('population data', () => {
  const all = [...LOCATIONS, ...PACK_CITIES];

  it('covers all but a handful of the corpus', () => {
    const withPop = all.filter((l) => l.pop !== undefined);
    expect(withPop.length / all.length).toBeGreaterThan(0.99);
    // Every curated location resolved; only the long tail has gaps.
    expect(LOCATIONS.every((l) => l.pop !== undefined)).toBe(true);
  });

  it('carries figures that are populations of cities', () => {
    for (const l of all) {
      if (l.pop === undefined) continue;
      expect(Number.isInteger(l.pop)).toBe(true);
      // A city-proper figure. The largest on earth is around 22M; anything
      // above that is a province total that has landed on a city by mistake.
      expect(l.pop).toBeGreaterThan(0);
      expect(l.pop).toBeLessThan(30_000_000);
    }
  });

  it('puts the well-known cities in the right order of magnitude', () => {
    const by = (id: string) => all.find((l) => l.id === id)!;
    expect(by('tokyo').pop).toBeGreaterThan(5_000_000);
    expect(by('london').pop).toBeGreaterThan(5_000_000);
    expect(by('amman').pop).toBeGreaterThan(500_000);
    // A US state capital that is a small city, not a big one.
    expect(by('us-vt').pop).toBeLessThan(100_000); // Montpelier
    expect(by('us-ak').pop).toBeLessThan(100_000); // Juneau
  });
});
