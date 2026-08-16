import { describe, it, expect } from 'vitest';
import {
  createSession,
  commitGuess,
  currentLocation,
  timeLimitFor,
  totalScore,
  totalPoints,
  maxPoints,
  scorePercent,
  averageScore,
  multiplierFor,
  currentMultiplier,
  survivalTimeForRound,
  DAILY_MULTIPLIERS,
  DAILY_MAX_POINTS,
  SURVIVAL_LIVES,
  SURVIVAL_MIN_SEC,
} from '../src/core/game';
import type { Location } from '../src/data/types';

const mk = (id: string, lat: number, lon: number): Location => ({
  id,
  name: id,
  country: 'X',
  lat,
  lon,
  tier: 1,
  continent: 'europe',
  tags: ['capital'],
});

const QUEUE = [
  mk('a', 48.857, 2.352),
  mk('b', 51.507, -0.128),
  mk('c', 40.417, -3.703),
  mk('d', 52.52, 13.405),
  mk('e', 41.893, 12.483),
];

describe('classic session', () => {
  it('runs 5 rounds then finishes', () => {
    const s = createSession('classic', QUEUE);
    expect(timeLimitFor(s)).toBeNull();
    for (let i = 0; i < 5; i++) {
      const loc = currentLocation(s)!;
      expect(loc).toBeTruthy();
      commitGuess(s, { lat: loc.lat, lon: loc.lon }); // perfect guesses
    }
    expect(s.finished).toBe(true);
    expect(currentLocation(s)).toBeNull();
    expect(totalScore(s)).toBe(500);
    expect(averageScore(s)).toBe(100);
    // …and a flawless five-clue Daily is exactly 1,000 points.
    expect(totalPoints(s)).toBe(DAILY_MAX_POINTS);
    expect(scorePercent(s)).toBe(100);
  });

  it('scores a timeout (null guess) as zero', () => {
    const s = createSession('classic', QUEUE);
    const r = commitGuess(s, null);
    expect(r.score).toBe(0);
    expect(r.errorKm).toBe(Infinity);
  });

  it('throws when committing after the session is over', () => {
    const s = createSession('classic', [QUEUE[0]]);
    commitGuess(s, null);
    expect(s.finished).toBe(true);
    expect(() => commitGuess(s, null)).toThrow();
  });
});

describe('blitz session', () => {
  it('has a 20 second clock', () => {
    const s = createSession('blitz', QUEUE);
    expect(timeLimitFor(s)).toBe(20);
  });
});

describe('survival session', () => {
  it('loses a life on a bad round and ends at zero lives', () => {
    const s = createSession('survival', QUEUE);
    expect(s.lives).toBe(SURVIVAL_LIVES);
    // three whiffs = three lives gone
    commitGuess(s, null);
    commitGuess(s, null);
    expect(s.finished).toBe(false);
    commitGuess(s, null);
    expect(s.lives).toBe(0);
    expect(s.finished).toBe(true);
  });

  it('keeps lives on good rounds', () => {
    const s = createSession('survival', QUEUE);
    const loc = currentLocation(s)!;
    commitGuess(s, { lat: loc.lat, lon: loc.lon });
    expect(s.lives).toBe(SURVIVAL_LIVES);
    expect(s.finished).toBe(false);
  });

  it('shrinks the clock but respects the floor', () => {
    expect(survivalTimeForRound(0)).toBe(20);
    expect(survivalTimeForRound(5)).toBe(15);
    expect(survivalTimeForRound(50)).toBe(SURVIVAL_MIN_SEC);
  });

  it('finishes when the queue is exhausted even with lives left', () => {
    const s = createSession('survival', [QUEUE[0]]);
    const loc = currentLocation(s)!;
    commitGuess(s, { lat: loc.lat, lon: loc.lon });
    expect(s.finished).toBe(true);
  });
});

describe('MapTap round multipliers', () => {
  it('applies the [1,1,2,3,3] Daily ladder to the five-clue modes', () => {
    expect([...DAILY_MULTIPLIERS]).toEqual([1, 1, 2, 3, 3]);
    for (const mode of ['classic', 'blitz'] as const) {
      expect([0, 1, 2, 3, 4].map((i) => multiplierFor(mode, i))).toEqual([1, 1, 2, 3, 3]);
    }
  });

  it('sums to a 1,000-point maximum', () => {
    const total = [0, 1, 2, 3, 4].reduce((a, i) => a + multiplierFor('classic', i) * 100, 0);
    expect(total).toBe(DAILY_MAX_POINTS);
    expect(maxPoints(createSession('classic', QUEUE))).toBe(DAILY_MAX_POINTS);
  });

  it('scores Survival and Drill flat, like Frontier and Practice', () => {
    for (const i of [0, 1, 2, 3, 4, 9]) {
      expect(multiplierFor('survival', i)).toBe(1);
      expect(multiplierFor('drill', i)).toBe(1);
    }
  });

  it('falls back to ×1 past the fifth round', () => {
    expect(multiplierFor('classic', 5)).toBe(1);
    expect(multiplierFor('classic', 99)).toBe(1);
  });

  it('records the multiplier in force on each round result', () => {
    const s = createSession('classic', QUEUE);
    const mults: number[] = [];
    for (let i = 0; i < 5; i++) {
      expect(currentMultiplier(s)).toBe(DAILY_MULTIPLIERS[i]);
      const loc = currentLocation(s)!;
      mults.push(commitGuess(s, { lat: loc.lat, lon: loc.lon }).multiplier);
    }
    expect(mults).toEqual([1, 1, 2, 3, 3]);
    expect(s.results.map((r) => r.points)).toEqual([100, 100, 200, 300, 300]);
  });

  it('weights the grade toward the late rounds', () => {
    // Perfect on the two ×1 rounds, blank on everything after: the flat
    // average says 40%, but only 200 of 1,000 points actually landed.
    const s = createSession('classic', QUEUE);
    for (let i = 0; i < 5; i++) {
      const loc = currentLocation(s)!;
      commitGuess(s, i < 2 ? { lat: loc.lat, lon: loc.lon } : null);
    }
    expect(averageScore(s)).toBe(40);
    expect(totalPoints(s)).toBe(200);
    expect(scorePercent(s)).toBe(20);
  });

  it('leaves survival totals unweighted', () => {
    const s = createSession('survival', QUEUE);
    const loc = currentLocation(s)!;
    const r = commitGuess(s, { lat: loc.lat, lon: loc.lon });
    expect(r.multiplier).toBe(1);
    expect(r.points).toBe(r.score);
    expect(maxPoints(s)).toBe(100); // open-ended: only the rounds played count
  });
});
