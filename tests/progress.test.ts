import { describe, it, expect } from 'vitest';
import {
  sessionAvg,
  rollupByDay,
  lastNDays,
  weekOverWeek,
  recentTrend,
} from '../src/core/progress';
import type { SessionSummary } from '../src/core/storage';

const DAY = 86_400_000;
// Fixed local-noon anchor so day bucketing is stable regardless of timezone.
const NOW = new Date(2026, 7, 12, 12, 0, 0).getTime();

const mk = (daysAgo: number, rounds: number, totalScore: number): SessionSummary => ({
  mode: 'classic',
  when: NOW - daysAgo * DAY,
  rounds,
  totalScore,
  avgErrorKm: 100,
});

describe('sessionAvg', () => {
  it('divides total by rounds and guards zero', () => {
    expect(sessionAvg(mk(0, 5, 400))).toBe(80);
    expect(sessionAvg(mk(0, 0, 0))).toBe(0);
  });
});

describe('rollupByDay', () => {
  it('merges same-day sessions round-weighted and sorts ascending', () => {
    const rolled = rollupByDay([mk(1, 5, 500), mk(0, 5, 100), mk(0, 15, 900)]);
    expect(rolled).toHaveLength(2);
    expect(rolled[0].avgScore).toBe(100); // yesterday
    expect(rolled[1].sessions).toBe(2);
    expect(rolled[1].rounds).toBe(20);
    expect(rolled[1].avgScore).toBe(50); // (100+900)/20
    expect(rolled[0].day < rolled[1].day).toBe(true);
  });
});

describe('lastNDays', () => {
  it('fills empty days and always returns n entries ending today', () => {
    const days = lastNDays([mk(2, 5, 250)], 7, NOW);
    expect(days).toHaveLength(7);
    expect(days.filter((d) => d.rounds > 0)).toHaveLength(1);
    expect(days[4].avgScore).toBe(50); // 2 days ago
    expect(days[6].rounds).toBe(0); // today, unplayed
  });
});

describe('weekOverWeek', () => {
  it('computes both windows and the delta', () => {
    const w = weekOverWeek([mk(1, 5, 400), mk(9, 5, 300)], NOW);
    expect(w.thisWeek).toBe(80);
    expect(w.lastWeek).toBe(60);
    expect(w.delta).toBe(20);
  });

  it('returns null delta when a window is empty', () => {
    const w = weekOverWeek([mk(1, 5, 400)], NOW);
    expect(w.thisWeek).toBe(80);
    expect(w.lastWeek).toBeNull();
    expect(w.delta).toBeNull();
  });
});

describe('recentTrend', () => {
  it('is positive when newer sessions beat older ones', () => {
    const hist = [mk(5, 5, 200), mk(4, 5, 200), mk(2, 5, 400), mk(1, 5, 400)];
    expect(recentTrend(hist)).toBe(40);
  });

  it('is null with too little data', () => {
    expect(recentTrend([mk(1, 5, 400)])).toBeNull();
  });
});
