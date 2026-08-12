/**
 * Game session state machine. Modes mirror MapTap.gg:
 *  - classic:  5 rounds, untimed — the Daily-game format.
 *  - blitz:    5 rounds, 20 s each — Versus/Gauntlet pacing.
 *  - survival: endless, shrinking clock, 3 lives — Frontier pacing.
 *  - drill:    10 rounds over a filtered pool, weakness-weighted.
 */
import type { Location } from '../data/types';
import { haversineKm, scoreForDistance, type LatLon } from './geo';

export type ModeId = 'classic' | 'blitz' | 'survival' | 'drill';

export interface ModeConfig {
  rounds: number; // Infinity for survival
  timeLimitSec: number | null;
}

export const MODE_CONFIG: Record<ModeId, ModeConfig> = {
  classic: { rounds: 5, timeLimitSec: null },
  blitz: { rounds: 5, timeLimitSec: 20 },
  survival: { rounds: Infinity, timeLimitSec: 20 },
  drill: { rounds: 10, timeLimitSec: null },
};

/** Survival: clock shrinks 1 s per round, never below this floor. */
export const SURVIVAL_MIN_SEC = 6;
/** Survival: rounds scoring below this cost a life. */
export const SURVIVAL_PASS_SCORE = 40;
export const SURVIVAL_LIVES = 3;

export function survivalTimeForRound(roundIndex: number): number {
  return Math.max(SURVIVAL_MIN_SEC, 20 - roundIndex);
}

export interface RoundResult {
  location: Location;
  guess: LatLon | null; // null = timed out with no pin
  errorKm: number;
  score: number;
}

export interface Session {
  mode: ModeId;
  queue: Location[];
  results: RoundResult[];
  lives: number; // survival only
  finished: boolean;
}

export function createSession(mode: ModeId, queue: Location[]): Session {
  return { mode, queue, results: [], lives: SURVIVAL_LIVES, finished: false };
}

export function currentRound(s: Session): number {
  return s.results.length;
}

export function currentLocation(s: Session): Location | null {
  if (s.finished) return null;
  return s.queue[s.results.length] ?? null;
}

export function timeLimitFor(s: Session): number | null {
  if (s.mode === 'survival') return survivalTimeForRound(currentRound(s));
  return MODE_CONFIG[s.mode].timeLimitSec;
}

/** Commit a guess (or null on timeout) for the current round. */
export function commitGuess(s: Session, guess: LatLon | null): RoundResult {
  const loc = currentLocation(s);
  if (!loc) throw new Error('No active round');
  const errorKm = guess ? haversineKm(guess, loc) : Infinity;
  const score = guess ? scoreForDistance(errorKm) : 0;
  const result: RoundResult = { location: loc, guess, errorKm, score };
  s.results.push(result);

  if (s.mode === 'survival') {
    if (score < SURVIVAL_PASS_SCORE) s.lives -= 1;
    if (s.lives <= 0 || s.results.length >= s.queue.length) s.finished = true;
  } else if (s.results.length >= Math.min(s.queue.length, MODE_CONFIG[s.mode].rounds)) {
    s.finished = true;
  }
  return result;
}

export function totalScore(s: Session): number {
  return s.results.reduce((sum, r) => sum + r.score, 0);
}

export function averageScore(s: Session): number {
  return s.results.length ? totalScore(s) / s.results.length : 0;
}
