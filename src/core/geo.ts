/**
 * Geodesy + scoring, calibrated against MapTap.gg.
 *
 * Two things had to be right for MapTrainer's numbers to mean anything:
 *
 * 1. The per-round curve. MapTap scores each tap 0–100 by great-circle error.
 *    The exact formula is unpublished, so the curve here is fitted to the
 *    score distribution of 2,240 real MapTap rounds (see `docs/scoring.md`).
 *    The headline correction over the old model: MapTap's tail is *fat*.
 *    Real players post scores in the 10–45 band often enough (≈15% of all
 *    rounds) that a plain exp(-d/400) — which is already at ~0 by 1,200 km —
 *    can't produce them. A stretched exponential does: gentle near the
 *    target, long-tailed across oceans, only reaching 0 at antipodal range.
 *
 * 2. The round multipliers, which live in `game.ts`.
 */

export const EARTH_RADIUS_KM = 6371;

/** Perfect-score radius, km — inside this you get a flat 100. */
export const BULLSEYE_KM = 15;
/** Stretched-exponential scale, km. */
export const DECAY_SCALE_KM = 1400;
/**
 * Stretch exponent. <1 flattens the near field and fattens the far tail,
 * which is what separates MapTap's curve from a plain exponential.
 */
export const DECAY_SHAPE = 0.85;
export const MAX_SCORE = 100;

export interface LatLon {
  lat: number;
  lon: number;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in km (haversine). */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Distance → 0–100 score. Monotonically non-increasing.
 *
 * Reference points on this curve:
 *   ≤15 km → 100 · 50 km → 96 · 100 km → 91 · 250 km → 80 · 500 km → 67
 *   1,000 km → 48 · 2,000 km → 26 · 5,000 km → 5 · 12,000 km+ → 0
 */
export function scoreForDistance(km: number): number {
  if (!Number.isFinite(km) || km < 0) return 0;
  if (km <= BULLSEYE_KM) return MAX_SCORE;
  const reach = (km - BULLSEYE_KM) / DECAY_SCALE_KM;
  return Math.round(MAX_SCORE * Math.exp(-Math.pow(reach, DECAY_SHAPE)));
}

/**
 * MapTap's share grid uses an emoji per round instead of the raw number.
 * Bands (and their members) are read off the emoji→score ranges observed in
 * the same 2,240-round sample; MapTap picks one at random within a band.
 */
const SCORE_EMOJI: { min: number; emoji: string[] }[] = [
  { min: 95, emoji: ['🎯', '🔥', '💯', '🏅', '🥇'] },
  { min: 85, emoji: ['🏆', '👑', '🥈', '🎉'] },
  { min: 75, emoji: ['🌟', '⭐', '✨', '😁', '👏', '🌞'] },
  { min: 60, emoji: ['🤗', '😂', '🙂', '🙊', '🤫'] },
  { min: 45, emoji: ['😐', '🤔', '😕', '😌', '😔'] },
  { min: 30, emoji: ['😮', '😟', '😞', '😢', '😴', '🙈'] },
  { min: 15, emoji: ['🥶', '❄️', '🧊', '😡'] },
  { min: 0, emoji: ['😱', '🤢', '😭'] },
];

/** Share-grid emoji for a 0–100 round score. */
export function scoreEmoji(score: number, rand = Math.random): string {
  const band = SCORE_EMOJI.find((b) => score >= b.min) ?? SCORE_EMOJI[SCORE_EMOJI.length - 1];
  return band.emoji[Math.floor(rand() * band.emoji.length)];
}

/** Human-friendly distance label. */
export function formatKm(km: number): string {
  if (km < 1) return '<1 km';
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

/** Grade letter for a 0–100 average. */
export function grade(avg: number): string {
  if (avg >= 97) return 'GOAT';
  if (avg >= 90) return 'S';
  if (avg >= 80) return 'A';
  if (avg >= 65) return 'B';
  if (avg >= 50) return 'C';
  if (avg >= 30) return 'D';
  return 'F';
}
