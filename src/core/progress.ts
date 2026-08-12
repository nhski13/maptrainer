/**
 * Longitudinal progress: rolls session history into day buckets and trends
 * so the Stats screen can answer "am I actually getting better?"
 */
import type { SessionSummary } from './storage';
import { localDay } from './storage';

export interface DayRollup {
  day: string; // YYYY-MM-DD
  sessions: number;
  rounds: number;
  /** Round-weighted average score 0–100. */
  avgScore: number;
}

export const sessionAvg = (s: SessionSummary): number =>
  s.rounds > 0 ? s.totalScore / s.rounds : 0;

/** Group history into per-day rollups, ascending by day. */
export function rollupByDay(history: SessionSummary[]): DayRollup[] {
  const byDay = new Map<string, { sessions: number; rounds: number; score: number }>();
  for (const s of history) {
    const day = localDay(new Date(s.when));
    const b = byDay.get(day) ?? { sessions: 0, rounds: 0, score: 0 };
    b.sessions += 1;
    b.rounds += s.rounds;
    b.score += s.totalScore;
    byDay.set(day, b);
  }
  return [...byDay.entries()]
    .map(([day, b]) => ({
      day,
      sessions: b.sessions,
      rounds: b.rounds,
      avgScore: b.rounds > 0 ? b.score / b.rounds : 0,
    }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** The last `n` calendar days (inclusive of today), empty days filled in. */
export function lastNDays(history: SessionSummary[], n: number, now = Date.now()): DayRollup[] {
  const rolled = new Map(rollupByDay(history).map((r) => [r.day, r]));
  const out: DayRollup[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = localDay(new Date(now - i * 86_400_000));
    out.push(rolled.get(day) ?? { day, sessions: 0, rounds: 0, avgScore: 0 });
  }
  return out;
}

export interface WeekDelta {
  /** Round-weighted avg over the last 7 days, or null if no play. */
  thisWeek: number | null;
  /** …over the 7 days before that. */
  lastWeek: number | null;
  /** thisWeek − lastWeek, or null unless both exist. */
  delta: number | null;
}

export function weekOverWeek(history: SessionSummary[], now = Date.now()): WeekDelta {
  const avgOf = (from: number, to: number): number | null => {
    let rounds = 0;
    let score = 0;
    for (const s of history) {
      if (s.when >= from && s.when < to) {
        rounds += s.rounds;
        score += s.totalScore;
      }
    }
    return rounds > 0 ? score / rounds : null;
  };
  const week = 7 * 86_400_000;
  const thisWeek = avgOf(now - week, now + 1);
  const lastWeek = avgOf(now - 2 * week, now - week);
  return {
    thisWeek,
    lastWeek,
    delta: thisWeek !== null && lastWeek !== null ? thisWeek - lastWeek : null,
  };
}

/**
 * Simple improvement signal over the last `n` sessions: mean of the newer
 * half minus mean of the older half. Positive = improving.
 */
export function recentTrend(history: SessionSummary[], n = 10): number | null {
  const recent = history.slice(-n);
  if (recent.length < 4) return null;
  const mid = Math.floor(recent.length / 2);
  const mean = (xs: SessionSummary[]): number =>
    xs.reduce((s, x) => s + sessionAvg(x), 0) / xs.length;
  return mean(recent.slice(mid)) - mean(recent.slice(0, mid));
}
