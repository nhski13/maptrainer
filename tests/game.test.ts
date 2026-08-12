import { describe, it, expect } from 'vitest';
import {
  createSession,
  commitGuess,
  currentLocation,
  timeLimitFor,
  totalScore,
  averageScore,
  survivalTimeForRound,
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
