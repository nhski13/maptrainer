/** localStorage persistence for stats, streaks, and session history. */
import type { StatsMap } from './srs';

const STATS_KEY = 'maptrainer.stats.v1';
const HISTORY_KEY = 'maptrainer.history.v1';
const STREAK_KEY = 'maptrainer.streak.v1';

export interface SessionSummary {
  mode: string;
  when: number;
  rounds: number;
  totalScore: number;
  avgErrorKm: number;
}

export interface StreakState {
  current: number;
  best: number;
  lastDay: string; // YYYY-MM-DD local
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full/unavailable — training still works, just won't persist.
  }
}

export const loadStats = (): StatsMap => read<StatsMap>(STATS_KEY, {});
export const saveStats = (s: StatsMap): void => write(STATS_KEY, s);

export const loadHistory = (): SessionSummary[] => read<SessionSummary[]>(HISTORY_KEY, []);
export function appendHistory(entry: SessionSummary): void {
  const h = loadHistory();
  h.push(entry);
  write(HISTORY_KEY, h.slice(-200)); // keep the last 200 sessions
}

export function localDay(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Bump the daily training streak; call once per completed session. */
export function bumpStreak(today = localDay()): StreakState {
  const s = read<StreakState>(STREAK_KEY, { current: 0, best: 0, lastDay: '' });
  if (s.lastDay === today) return s; // already trained today
  const yesterday = localDay(new Date(Date.now() - 86_400_000));
  s.current = s.lastDay === yesterday ? s.current + 1 : 1;
  s.best = Math.max(s.best, s.current);
  s.lastDay = today;
  write(STREAK_KEY, s);
  return s;
}

export const loadStreak = (): StreakState =>
  read<StreakState>(STREAK_KEY, { current: 0, best: 0, lastDay: '' });

export function resetAll(): void {
  localStorage.removeItem(STATS_KEY);
  localStorage.removeItem(HISTORY_KEY);
  localStorage.removeItem(STREAK_KEY);
}
