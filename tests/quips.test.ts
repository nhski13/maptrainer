import { describe, it, expect } from 'vitest';
import { tierForScore, pickQuip, QUIPS, TIMEOUT_QUIPS, GRADE_QUIPS } from '../src/core/quips';
import { grade } from '../src/core/geo';

describe('tierForScore', () => {
  it('maps score boundaries to tiers', () => {
    expect(tierForScore(100)).toBe('perfect');
    expect(tierForScore(99)).toBe('good');
    expect(tierForScore(80)).toBe('good');
    expect(tierForScore(79)).toBe('mid');
    expect(tierForScore(40)).toBe('mid');
    expect(tierForScore(39)).toBe('bad');
    expect(tierForScore(10)).toBe('bad');
    expect(tierForScore(9)).toBe('brutal');
    expect(tierForScore(0)).toBe('brutal');
  });
});

describe('quip pools', () => {
  it('every tier has multiple lines', () => {
    for (const [tier, pool] of Object.entries(QUIPS)) {
      expect(pool.length, tier).toBeGreaterThanOrEqual(4);
    }
    expect(TIMEOUT_QUIPS.length).toBeGreaterThanOrEqual(3);
  });

  it('covers every grade the grader can emit', () => {
    for (const avg of [100, 95, 85, 70, 55, 35, 5]) {
      expect(GRADE_QUIPS[grade(avg)], `grade ${grade(avg)}`).toBeTruthy();
    }
  });
});

describe('pickQuip', () => {
  it('draws from the matching tier pool', () => {
    expect(QUIPS.perfect).toContain(pickQuip(100, false, () => 0));
    expect(QUIPS.brutal).toContain(pickQuip(0, false, () => 0.99));
    expect(QUIPS.bad).toContain(pickQuip(20, false, () => 0.5));
  });

  it('uses the timeout pool when no pin was placed', () => {
    expect(TIMEOUT_QUIPS).toContain(pickQuip(0, true, () => 0));
  });
});
