/**
 * Weakness-weighted spaced repetition.
 *
 * Every attempt updates an exponential moving average of the score for that
 * location. Selection weights favor: (1) locations you score poorly on,
 * (2) locations you've never seen, (3) locations you haven't seen recently.
 * This is what turns grinding into targeted improvement.
 */
import type { Location } from '../data/types';

export interface LocationStat {
  attempts: number;
  /** EMA of round scores (0–100). */
  emaScore: number;
  /** EMA of error distance in km. */
  emaErrorKm: number;
  bestKm: number;
  lastSeen: number; // epoch ms
}

export type StatsMap = Record<string, LocationStat>;

const EMA_ALPHA = 0.35;

export function updateStat(
  prev: LocationStat | undefined,
  score: number,
  errorKm: number,
  now: number,
): LocationStat {
  if (!prev) {
    return {
      attempts: 1,
      emaScore: score,
      emaErrorKm: errorKm,
      bestKm: errorKm,
      lastSeen: now,
    };
  }
  return {
    attempts: prev.attempts + 1,
    emaScore: prev.emaScore + EMA_ALPHA * (score - prev.emaScore),
    emaErrorKm: prev.emaErrorKm + EMA_ALPHA * (errorKm - prev.emaErrorKm),
    bestKm: Math.min(prev.bestKm, errorKm),
    lastSeen: now,
  };
}

/**
 * Selection weight for a location. Higher = more likely to be drilled.
 * Unseen locations get a strong exploration bonus; seen ones are weighted by
 * how badly you do on them and how long since you last saw them.
 */
export function selectionWeight(
  stat: LocationStat | undefined,
  now: number,
): number {
  if (!stat) return 1.5; // exploration bonus for unseen locations
  const weakness = (100 - stat.emaScore) / 100; // 0 (perfect) → 1 (hopeless)
  const daysSince = Math.max(0, (now - stat.lastSeen) / 86_400_000);
  const staleness = Math.min(1, daysSince / 7); // fully "due" after a week
  // Even mastered locations keep a floor so they resurface occasionally.
  return 0.1 + weakness * 2 + staleness * 0.5;
}

/**
 * Weighted sample of `count` distinct locations from `pool`.
 * Deterministic given `rng` (injectable for tests).
 */
export function pickWeighted(
  pool: Location[],
  stats: StatsMap,
  count: number,
  now: number,
  rng: () => number = Math.random,
): Location[] {
  const candidates = pool.map((loc) => ({
    loc,
    w: selectionWeight(stats[loc.id], now),
  }));
  const picked: Location[] = [];
  while (picked.length < count && candidates.length > 0) {
    const total = candidates.reduce((s, c) => s + c.w, 0);
    let r = rng() * total;
    let idx = candidates.length - 1;
    for (let i = 0; i < candidates.length; i++) {
      r -= candidates[i].w;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    picked.push(candidates[idx].loc);
    candidates.splice(idx, 1);
  }
  return picked;
}

/** Lowest-EMA locations the player has actually attempted. */
export function weakestLocations(
  pool: Location[],
  stats: StatsMap,
  count: number,
): Location[] {
  return pool
    .filter((l) => stats[l.id] !== undefined)
    .sort((a, b) => stats[a.id].emaScore - stats[b.id].emaScore)
    .slice(0, count);
}
