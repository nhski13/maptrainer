/**
 * Geodesy + scoring, calibrated against MapTap.gg.
 *
 * Two things had to be right for MapTrainer's numbers to mean anything:
 *
 * 1. The per-round curve. MapTap scores each tap 0–100 by great-circle error.
 *    The formula is unpublished, so this one is fitted to measured rounds
 *    read off the game's own reveal screen — six of them now, spanning
 *    362 km to 13,060 km. See `docs/scoring.md`.
 *
 *    MapTap is forgiving in the middle of its range and less so at the ends
 *    than a naive curve suggests. A miss the width of Germany costs ~8
 *    points, a coast-to-coast miss across the USA is still a 58, and zero
 *    arrives around 14,300 km rather than at the antipode.
 *
 * 2. The round multipliers, which live in `game.ts`.
 */

export const EARTH_RADIUS_KM = 6371;
export const MAX_SCORE = 100;

/*
 * ---------------------------------------------------------------------------
 * THE CURVE
 *
 * The curve is `100 · (1 − ((d − 40 km) / 14,300 km) ^ 0.65)`, and these are
 * its constants. They are fitted to (distance, score) pairs read straight off
 * MapTap's own reveal screen:
 *
 *   Wolfsburg        362 km →  92   ✅
 *   Fairbanks        538 km →  89   ✅   (334 mi, MapTap #788)
 *   Samarkand        541 km →  89   ✅   (336 mi, MapTap #788)
 *   Karakorum      1,022 km →  80   ✗ 82 (635 mi, MapTap #788)
 *   Santa Monica   3,820 km →  58   ✅
 *   Nicosia       13,060 km →   6   ✅
 *
 * Five of six exact, worst error 2. The previous model — the remaining
 * fraction of the way to the antipode raised to a power — could not do this:
 * it hit the two far rounds exactly and then over-scored every near round,
 * by 3, 4, 4 and 7 respectively. The near rounds are the ones a trainer
 * spends its life in, so the family had to change, not just the exponent.
 *
 * What changed is the shape of the loss. Points lost grow as a *sublinear
 * power of distance*, not linearly in the remaining fraction: doubling your
 * error nowhere near doubles the damage. That is what lets one curve be
 * strict at 500 km (11 points gone) and generous at 3,820 km (only 42).
 * ---------------------------------------------------------------------------
 */

/** Distance at which the curve reaches zero — the fitted scale, not the antipode. */
export const ZERO_SCORE_KM = 14300;

/**
 * Exponent on the distance ratio. Fitted jointly with `ZERO_SCORE_KM`; the
 * window that keeps five of the six anchors exact is narrow (D 14,205–14,430
 * with p 0.6485–0.6520), so neither constant is free to drift far.
 */
export const SCORE_EXPONENT = 0.65;

/**
 * Bullseye radius: a tap within 40 km of the city — metro-area scale — reads
 * as a bullseye and scores 100.
 *
 * Unlike the two constants above, this one is NOT fitted to the anchors. The
 * nearest measured round is Wolfsburg at 362 km, so nothing in the anchor set
 * constrains the first few hundred km: any grace radius between 0 and ~80 km
 * fits the six rounds equally well. It is set from a different piece of
 * evidence — the 2025 archive in `docs/scoring.md`, where 5–11% of rounds
 * score exactly 100. Without a plateau the bare curve only pays 100 inside
 * ~4 km, which no plausible tap distribution reaches that often.
 *
 * Treat it as the least certain number in this file. A measured round inside
 * 200 km would pin it down.
 */
export const BULLSEYE_KM = 40;

/** Antipodal distance — the furthest you can possibly be, ~20,015 km. */
export const ANTIPODAL_KM = Math.PI * EARTH_RADIUS_KM;

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
 * Distance → 0–100 score: points lost grow as a sublinear power of the error,
 * past a metro-sized bullseye.
 *
 *   score(d) = 100 · (1 − ((d − 40 km) / 14,300 km) ^ 0.65)
 *
 * Reference points:
 *   ≤44 km → 100 · 100 km → 97 · 362 km → 92 (measured) · 538 km → 89 (measured)
 *   1,022 km → 82 (measured 80) · 2,000 km → 73 · 3,820 km → 58 (measured)
 *   8,000 km → 32 · 13,060 km → 6 (measured) · 14,340 km+ → 0
 */
export function scoreForDistance(km: number): number {
  if (!Number.isFinite(km) || km < 0) return 0;
  const beyond = Math.max(0, km - BULLSEYE_KM);
  const lost = Math.pow(beyond / ZERO_SCORE_KM, SCORE_EXPONENT);
  return Math.round(MAX_SCORE * Math.max(0, 1 - lost));
}

/**
 * MapTap's share grid uses an emoji per round instead of the raw number.
 * Bands (and their members) are read off the emoji→score ranges seen in the
 * 12-player 2025 archive described in `docs/scoring.md`; MapTap picks one at
 * random within a band. Cosmetic only, and the sample is small and old — if
 * the emoji look wrong in a current share, this is why.
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
