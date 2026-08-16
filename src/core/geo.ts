/**
 * Geodesy + scoring, calibrated against MapTap.gg.
 *
 * Two things had to be right for MapTrainer's numbers to mean anything:
 *
 * 1. The per-round curve. MapTap scores each tap 0–100 by great-circle error.
 *    The formula is unpublished, so this one is anchored on a measured round
 *    from the game itself — 225 miles out scored 92 — which fixes its single
 *    free parameter. See `docs/scoring.md`.
 *
 *    MapTap is far more forgiving than it looks: 92 for a 362 km miss means
 *    the curve is nearly flat across a whole country, and a wrong-continent
 *    guess still banks 30–50. Both earlier models here were badly harsh —
 *    they scored that same Wolfsburg round 42 and 74 respectively.
 *
 * 2. The round multipliers, which live in `game.ts`.
 */

export const EARTH_RADIUS_KM = 6371;
export const MAX_SCORE = 100;

/** Antipodal distance — the furthest you can possibly be, ~20,015 km. */
export const ANTIPODAL_KM = Math.PI * EARTH_RADIUS_KM;

/**
 * Sole free parameter of the curve, fitted to a measured MapTap round:
 * Wolfsburg, 225 miles (362.1 km) out, scored 92.
 *
 *   k = ln(0.92) / ln(1 − 362.1/20015) = 4.567
 *
 * MapTap displays miles rounded to the unit and the score as a whole percent,
 * so the anchor really pins k to [4.28, 4.86]; 4.6 sits in the middle of that
 * window and reproduces the observed 92 exactly.
 */
export const SCORE_EXPONENT = 4.6;

/**
 * Bullseye radius, ~21.7 km: the distance at which the score stops rounding
 * to a flat 100 (it is exactly the 99.5 crossing, so treat it as the edge,
 * not as a value that scores 100 itself).
 *
 * Derived from the curve rather than imposed on it. The old model needed an
 * explicit bullseye bolted on to explain why 5–11% of real rounds score
 * exactly 100; this one produces one of about the right size on its own.
 */
export const BULLSEYE_KM =
  ANTIPODAL_KM * (1 - Math.pow(0.995, 1 / SCORE_EXPONENT));

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
 * Distance → 0–100 score: the remaining fraction of the way to the far side
 * of the planet, raised to a power. Smooth, monotonic, exactly 100 at zero
 * and exactly 0 at the antipode — no piecewise seams.
 *
 *   score(d) = 100 · (1 − d / 20,015 km) ^ 4.6
 *
 * Reference points:
 *   ≤22 km → 100 · 100 km → 98 · 362 km → 92 (measured) · 1,000 km → 79
 *   2,000 km → 62 · 3,000 km → 47 · 5,000 km → 27 · 10,000 km → 4
 */
export function scoreForDistance(km: number): number {
  if (!Number.isFinite(km) || km < 0) return 0;
  const remaining = Math.max(0, 1 - km / ANTIPODAL_KM);
  return Math.round(MAX_SCORE * Math.pow(remaining, SCORE_EXPONENT));
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

export const KM_PER_MILE = 1.609344;

/** Human-friendly distance label. */
export function formatKm(km: number): string {
  if (km < 1) return '<1 km';
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

/** Same, in miles — the unit MapTap itself reports errors in. */
export function formatMiles(km: number): string {
  const mi = km / KM_PER_MILE;
  if (mi < 1) return '<1 mi';
  if (mi < 100) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi).toLocaleString()} mi`;
}

/** Both units, for the reveal — MapTap reports miles, the app thinks in km. */
export function formatDistance(km: number): string {
  return `${formatKm(km)} · ${formatMiles(km)}`;
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
