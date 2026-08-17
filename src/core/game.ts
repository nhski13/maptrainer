/**
 * Game session state machine. Modes mirror MapTap.gg:
 *  - classic:  5 rounds, untimed — the Daily-game format.
 *  - blitz:    5 rounds, 20 s each — Versus/Gauntlet pacing.
 *  - survival: endless, shrinking clock, 3 lives — Frontier pacing.
 *  - drill:    10 rounds over a filtered pool, weakness-weighted.
 *  - country:  every city in one country's pack, most populous first.
 */
import type { Location } from '../data/types';
import { haversineKm, scoreForDistance, MAX_SCORE, type LatLon } from './geo';

export type ModeId = 'classic' | 'blitz' | 'survival' | 'drill' | 'country';

/**
 * MapTap's Daily multiplies the later (harder) clues: round 3 counts double,
 * rounds 4 and 5 count triple, so a flawless five-clue run is exactly 1,000.
 *
 * This ladder is not guesswork — it was solved from 434 complete real MapTap
 * games (per-round scores + shared totals) archived by a 12-player friend
 * group over 82 days in late 2025. [1,1,2,3,3] reproduces the posted total
 * exactly in 94.2% of them; the next-best candidate manages 6.5%, and the
 * residual misses are transcription noise in the source data. A small sample
 * is fine here because the ladder is structural, not statistical — and an
 * in-game screenshot ("Round: 3 (medium - points doubled)") confirms it
 * independently.
 */
export const DAILY_MULTIPLIERS: readonly number[] = [1, 1, 2, 3, 3];
/** A flawless five-clue Daily. */
export const DAILY_MAX_POINTS = 1000;

/**
 * Multiplier for a round. Classic and Blitz are MapTrainer's five-clue modes,
 * so they carry the Daily ladder. Survival and Drill score flat, mirroring
 * MapTap's Frontier and Practice: Frontier escalates through the clock and the
 * location pool rather than the scoreboard, and Practice gates XP on hitting
 * 90%+ per location, where a multiplier would only blur the threshold.
 */
export function multiplierFor(mode: ModeId, roundIndex: number): number {
  if (mode !== 'classic' && mode !== 'blitz') return 1;
  return DAILY_MULTIPLIERS[roundIndex] ?? 1;
}

/**
 * MapTap labels each Daily round by difficulty rather than by number — its
 * reveal reads "Round: 3 (medium - points doubled)". The label and the
 * multiplier are the same ladder: easy ×1, medium ×2, hard ×3.
 */
export type Difficulty = 'easy' | 'medium' | 'hard';

const DIFFICULTY_BY_MULTIPLIER: Record<number, Difficulty> = {
  1: 'easy',
  2: 'medium',
  3: 'hard',
};

/** Difficulty label for a round, or null in the flat-scored modes. */
export function difficultyFor(mode: ModeId, roundIndex: number): Difficulty | null {
  if (mode !== 'classic' && mode !== 'blitz') return null;
  if (roundIndex >= DAILY_MULTIPLIERS.length) return null;
  return DIFFICULTY_BY_MULTIPLIER[multiplierFor(mode, roundIndex)] ?? null;
}

export interface ModeConfig {
  /** Infinity means "however long the queue is" — survival and country. */
  rounds: number;
  timeLimitSec: number | null;
}

export const MODE_CONFIG: Record<ModeId, ModeConfig> = {
  classic: { rounds: 5, timeLimitSec: null },
  blitz: { rounds: 5, timeLimitSec: 20 },
  survival: { rounds: Infinity, timeLimitSec: 20 },
  drill: { rounds: 10, timeLimitSec: null },
  // A country run is defined by its pack, not by a round count: you asked to
  // learn India's top 25, so the session is exactly those 25.
  country: { rounds: Infinity, timeLimitSec: null },
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
  /** Raw MapTap round score, 0–100 — the skill number. */
  score: number;
  /** Round multiplier in force (×1/×2/×3). */
  multiplier: number;
  /** score × multiplier — what lands on the scoreboard. */
  points: number;
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

/** Multiplier for the round about to be played. */
export function currentMultiplier(s: Session): number {
  return multiplierFor(s.mode, currentRound(s));
}

/** Rounds this session will run. Survival is open-ended, so: rounds so far. */
export function plannedRounds(s: Session): number {
  if (s.mode === 'survival') return s.results.length;
  return Math.min(s.queue.length, MODE_CONFIG[s.mode].rounds);
}

/** Commit a guess (or null on timeout) for the current round. */
export function commitGuess(s: Session, guess: LatLon | null): RoundResult {
  const loc = currentLocation(s);
  if (!loc) throw new Error('No active round');
  const errorKm = guess ? haversineKm(guess, loc) : Infinity;
  const score = guess ? scoreForDistance(errorKm) : 0;
  const multiplier = currentMultiplier(s);
  const result: RoundResult = {
    location: loc,
    guess,
    errorKm,
    score,
    multiplier,
    points: score * multiplier,
  };
  s.results.push(result);

  if (s.mode === 'survival') {
    if (score < SURVIVAL_PASS_SCORE) s.lives -= 1;
    if (s.lives <= 0 || s.results.length >= s.queue.length) s.finished = true;
  } else if (s.results.length >= Math.min(s.queue.length, MODE_CONFIG[s.mode].rounds)) {
    s.finished = true;
  }
  return result;
}

/** Sum of raw 0–100 round scores — the unweighted skill basis. */
export function totalScore(s: Session): number {
  return s.results.reduce((sum, r) => sum + r.score, 0);
}

export function averageScore(s: Session): number {
  return s.results.length ? totalScore(s) / s.results.length : 0;
}

/** Multiplied scoreboard total — the number MapTap shares. */
export function totalPoints(s: Session): number {
  return s.results.reduce((sum, r) => sum + r.points, 0);
}

/** Points available across the whole session (1,000 for a five-clue Daily). */
export function maxPoints(s: Session): number {
  let max = 0;
  for (let i = 0; i < plannedRounds(s); i++) max += multiplierFor(s.mode, i) * MAX_SCORE;
  return max;
}

/** Points available across the rounds actually played so far. */
export function pointsPlayed(s: Session): number {
  return s.results.reduce((sum, r) => sum + r.multiplier * MAX_SCORE, 0);
}

/**
 * Multiplier-weighted percentage, 0–100 — grade this, not the flat average.
 * Weighting is the point: fumbling the ×3 rounds should cost you a grade.
 */
export function scorePercent(s: Session): number {
  const denom = pointsPlayed(s);
  return denom ? (totalPoints(s) / denom) * 100 : 0;
}
