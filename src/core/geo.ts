/**
 * Geodesy + scoring. Scoring mirrors MapTap.gg's distance-based 0–100 model:
 * full marks inside a "bullseye" radius, then exponential decay. MapTap's exact
 * formula is unpublished, so constants are tuned so that city-level precision
 * (<15 km) is a perfect 100, region-level (~400 km) scores ~38, and
 * continent-level misses (1,200+ km) score near zero — matching the score
 * feedback MapTap shows ("87 km away" = strong, "1,200+ km" = bust).
 */

export const EARTH_RADIUS_KM = 6371;

/** Perfect-score radius, km. */
export const BULLSEYE_KM = 15;
/** Exponential decay scale, km. */
export const DECAY_KM = 400;
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

/** Distance → 0–100 score. Monotonically non-increasing in distance. */
export function scoreForDistance(km: number): number {
  if (!Number.isFinite(km) || km < 0) return 0;
  if (km <= BULLSEYE_KM) return MAX_SCORE;
  const s = MAX_SCORE * Math.exp(-(km - BULLSEYE_KM) / DECAY_KM);
  return Math.round(s);
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
